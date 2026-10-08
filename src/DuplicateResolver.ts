import { App, ButtonComponent, Modal, Notice, TFile } from "obsidian";
import Booksidian from "main";
import { getIdKeys } from "src/Book";
import { formatFrontmatter, mergeUnknownKeys, parseFrontmatter, stripFrontmatter } from "src/Frontmatter";
import { writeFile } from "src/helpers";

export interface DuplicateGroup {
	id: string;
	files: TFile[];
	destination: TFile;
}

/**
 * Group all notes in the vault that share the same Goodreads id across
 * the dictionary's id keys. Notes inside the target folder sort first,
 * and a note managed by ZotLit (it carries a `citekey`) is preferred
 * as the default merge destination.
 */
export function findDuplicateGroups(
	plugin: Booksidian,
): DuplicateGroup[] {
	const idKeys = getIdKeys(plugin.settings.frontmatterDictionary);
	const grouped = new Map<string, TFile[]>();

	for (const file of plugin.app.vault.getMarkdownFiles()) {
		const frontmatter = plugin.app.metadataCache.getFileCache(file)
			?.frontmatter as Record<string, unknown> | undefined;
		if (!frontmatter) continue;

		for (const key of idKeys) {
			const value = frontmatter[key];
			if (value === undefined || value === null || String(value) === "")
				continue;

			const files = grouped.get(String(value)) ?? [];
			files.push(file);
			grouped.set(String(value), files);
		}
	}

	const target = plugin.settings.targetFolderPath;
	const inTarget = (file: TFile): boolean => {
		if (!target) return false;
		return (
			file.path === target || file.path.startsWith(`${target}/`)
		);
	};

	const groups: DuplicateGroup[] = [];
	for (const [id, files] of grouped) {
		if (files.length < 2) continue;

		files.sort((a, b) => Number(inTarget(b)) - Number(inTarget(a)));
		const destination =
			files.find(
				(file) =>
					plugin.app.metadataCache.getFileCache(file)?.frontmatter
						?.citekey,
			) ?? files[0];
		groups.push({ id, files, destination });
	}

	return groups;
}

export class DuplicateResolverModal extends Modal {
	private plugin: Booksidian;

	public constructor(app: App, plugin: Booksidian) {
		super(app);
		this.plugin = plugin;
	}

	public onOpen(): void {
		const groups = findDuplicateGroups(this.plugin);
		const { contentEl } = this;

		this.modalEl.addClass("booksidian-plugin__duplicate-resolver");
		contentEl.createEl("h3", {
			text: "Booksidian: duplicate book notes",
		});

		if (groups.length === 0) {
			contentEl.createEl("p", {
				text: "No duplicate book notes found.",
			});
			this.addClose();
			return;
		}

		contentEl.createEl("p", {
			text: "Every group shows notes that share the same Goodreads id. Pick the note to keep; it keeps its body and frontmatter, plus any frontmatter keys only the other notes have. Failed or unexpected content is never destroyed without review.",
		});

		const appendBodyGroups = new Set<string>();

		groups.forEach((group) => {
			const fieldset = contentEl.createEl("fieldset");
			fieldset.addClass("booksidian-plugin__duplicate-group");
			fieldset.createEl("legend", {
				text: `Goodreads id ${group.id}`,
			});

			group.files.forEach((file) => {
				const label = fieldset.createEl("label");
				label.addClass("booksidian-plugin__duplicate-option");
				const radio = label.createEl("input", {
					type: "radio",
				});
				radio.name = `booksidian-dup-${group.id}`;
				radio.value = file.path;
				radio.checked = file.path === group.destination.path;
				label.createSpan({ text: ` ${file.path}` });
			});

			const appendLabel = fieldset.createEl("label");
			appendLabel.addClass("booksidian-plugin__duplicate-option");
			const appendCheckbox = appendLabel.createEl("input", {
				type: "checkbox",
			});
			appendCheckbox.dataset.group = group.id;
			appendCheckbox.addEventListener("change", () => {
				if (appendCheckbox.checked) appendBodyGroups.add(group.id);
				else appendBodyGroups.delete(group.id);
			});
			appendLabel.createSpan({
				text: " Append body of the other note(s) below the kept note",
			});
		});

		const deleteLabel = contentEl.createEl("label");
		deleteLabel.addClass("booksidian-plugin__duplicate-option");
		const deleteCheckbox = deleteLabel.createEl("input", {
			type: "checkbox",
		});
		deleteCheckbox.checked = true;
		deleteLabel.createSpan({
			text: " Move losing notes to the vault trash after merging",
		});

		const buttons = contentEl.createEl("div");
		buttons.addClass("booksidian-plugin__duplicate-buttons");
		new ButtonComponent(buttons)
			.setButtonText("Merge duplicates")
			.setCta()
			.onClick(async () => {
				const mergedGroups: string[] = [];
				const failedGroups: string[] = [];

				for (const group of groups) {
					try {
						const merged = await this.mergeGroup(
							group,
							appendBodyGroups.has(group.id),
							deleteCheckbox.checked,
						);
						if (merged) mergedGroups.push(group.id);
						else failedGroups.push(group.id);
					} catch (error) {
						console.log(
							`Booksidian: failed to merge group ${group.id}`,
							error,
						);
						failedGroups.push(group.id);
					}
				}

				if (mergedGroups.length > 0) {
					new Notice(
						`Booksidian: merged ${mergedGroups.length} duplicate group(s).`,
						5000,
					);
				}
				if (failedGroups.length > 0) {
					new Notice(
						`Booksidian: could not merge group(s) ${failedGroups.join(", ")} - no notes were removed.`,
						8000,
					);
				}
				this.close();
			});
		new ButtonComponent(buttons)
			.setButtonText("Cancel")
			.onClick(() => this.close());
	}

	private addClose(): void {
		const buttons = this.contentEl.createEl("div");
		buttons.addClass("booksidian-plugin__duplicate-buttons");
		new ButtonComponent(buttons)
			.setButtonText("Close")
			.onClick(() => this.close());
	}

	/**
	 * Merge one duplicate group. The survivor keeps its frontmatter and
	 * body; keys that only exist on the losing notes are copied over.
	 * Returns true when the group was merged, false when it was left
	 * untouched (e.g. parse problems).
	 */
	private async mergeGroup(
		group: DuplicateGroup,
		appendBody: boolean,
		deleteOthers: boolean,
	): Promise<boolean> {
		const selected = this.contentEl.querySelector<HTMLInputElement>(
			`input[name="booksidian-dup-${group.id}"]:checked`,
		);
		if (!selected) return false;

		const survivor = group.files.find(
			(file) => file.path === selected.value,
		);
		if (!survivor) return false;

		const others = group.files.filter((file) => file !== survivor);

		const survivorContent = await this.plugin.app.vault.read(survivor);
		const survivorFrontmatter = parseFrontmatter(survivorContent);
		if (!survivorFrontmatter) {
			// Without parseable frontmatter we cannot guarantee a safe
			// union; leave this group alone so nothing is destroyed.
			return false;
		}

		const survivorsExistingBody = stripFrontmatter(survivorContent);
		const extraKeys: Record<string, unknown> = {};
		const otherBodies: string[] = [];

		for (const other of others) {
			const otherContent = await this.plugin.app.vault.read(other);
			const otherFrontmatter = parseFrontmatter(otherContent);
			const otherBody = stripFrontmatter(otherContent);

			if (otherFrontmatter) {
				for (const key of Object.keys(otherFrontmatter)) {
					if (!(key in survivorFrontmatter)) {
						extraKeys[key] = otherFrontmatter[key];
					}
				}
			}
			if (appendBody && otherBody.trim()) {
				otherBodies.push(
					`%% Merged from [[${other.path}]] %%\n\n${otherBody.trim()}`,
				);
			}
		}

		const mergedYaml = mergeUnknownKeys(survivorFrontmatter, extraKeys);
		let newContent = formatFrontmatter(mergedYaml) + survivorsExistingBody;
		if (otherBodies.length) {
			newContent = newContent.trimEnd() + "\n\n" + otherBodies.join("\n\n") + "\n";
		}

		await writeFile(survivor.path, newContent, this.plugin.app);

		if (deleteOthers) {
			for (const other of others) {
				await this.plugin.app.vault.trash(other, true);
			}
		}

		return true;
	}

	public onClose(): void {
		this.contentEl.empty();
	}
}
