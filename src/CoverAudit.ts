import { App, ButtonComponent, Modal, Notice, TFile } from "obsidian";
import { isAbsolute } from "path";
import Booksidian from "main";
import { getIdKeys } from "src/Book";
import { pathExist } from "src/helpers";

export interface CoverIssue {
	file: TFile;
	id: string;
	category: "missing" | "outside" | "remote" | "none";
	detail: string;
}

const IMAGE_EXTENSIONS = [
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".bmp",
	".svg",
];

/**
 * Extract the first cover-ish reference from a note's frontmatter:
 * any string value that is a remote image URL or names an image file
 * (bare, path-qualified, or inside a wikilink).
 */
function findCoverReference(
	frontmatter: Record<string, unknown>,
): string | null {
	for (const key of Object.keys(frontmatter)) {
		const value = frontmatter[key];
		if (typeof value !== "string" || value === "") continue;

		// Unwrap wikilinks: [[58152486.jpg]] -> 58152486.jpg
		const clean = value
			.replace(/^\[\[/, "")
			.replace(/\]\]$/, "")
			.split("|")[0]
			.trim();

		if (/^https?:\/\//i.test(clean) && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(clean)) {
			return clean;
		}
		const lower = clean.toLowerCase();
		if (
			IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
			(IMAGE_EXTENSIONS.some((ext) => lower.includes(ext)) &&
				clean.includes("/"))
		) {
			return clean;
		}
	}
	return null;
}

/**
 * Audit book notes for cover problems. A "book note" here is any
 * markdown note carrying the dictionary's Goodreads id.
 */
export function findCoverIssues(plugin: Booksidian): CoverIssue[] {
	const idKeys = getIdKeys(plugin.settings.frontmatterDictionary);
	const coversFolder =
		plugin.settings.coverDownloadLocation.trim() !== ""
			? plugin.settings.coverDownloadLocation
			: `${plugin.settings.targetFolderPath || "."}/cover`;

	const folderPrefix = (path: string): boolean =>
		path === coversFolder || path.startsWith(`${coversFolder}/`);

	const issues: CoverIssue[] = [];

	for (const file of plugin.app.vault.getMarkdownFiles()) {
		const frontmatter = plugin.app.metadataCache.getFileCache(file)
			?.frontmatter as Record<string, unknown> | undefined;
		if (!frontmatter) continue;

		const idObject = idKeys
			.map((key) => String(frontmatter[key] ?? ""))
			.find((value) => value !== "");
		const coverReference = findCoverReference(frontmatter);
		if (!idObject && !coverReference) continue;

		const id = idObject || "?";

		if (!coverReference) {
			issues.push({
				file,
				id,
				category: "none",
				detail: "no cover property found in frontmatter",
			});
			continue;
		}

		if (/^https?:\/\//i.test(coverReference)) {
			issues.push({
				file,
				id,
				category: "remote",
				detail: `cover still points at the Goodreads URL: ${coverReference}`,
			});
			continue;
		}

		let dest = plugin.app.vault.getAbstractFileByPath(
			coverReference,
		) as TFile | null;
		if (!dest) {
			dest = plugin.app.metadataCache.getFirstLinkpathDest(
				coverReference,
				file.path,
			);
		}

		if (!dest && isAbsolute(coverReference)) {
			// Covers can live outside the vault.
			if (pathExist(coverReference)) {
				if (!folderPrefix(coverReference)) {
					issues.push({
						file,
						id,
						category: "outside",
						detail: `cover outside ${coversFolder}: ${coverReference}`,
					});
				}
				continue;
			}
		}

		if (!dest) {
			issues.push({
				file,
				id,
				category: "missing",
				detail: `cover file does not exist: ${coverReference}`,
			});
			continue;
		}

		if (!folderPrefix(dest.path)) {
			issues.push({
				file,
				id,
				category: "outside",
				detail: `cover outside ${coversFolder}: ${dest.path}`,
			});
		}
	}

	return issues;
}

export class CoverAuditModal extends Modal {
	private plugin: Booksidian;

	public constructor(app: App, plugin: Booksidian) {
		super(app);
		this.plugin = plugin;
	}

	public onOpen(): void {
		const issues = findCoverIssues(this.plugin);
		const { contentEl } = this;

		this.modalEl.addClass("booksidian-plugin__cover-audit");
		contentEl.createEl("h3", {
			text: "Booksidian: cover audit",
		});

		if (issues.length === 0) {
			contentEl.createEl("p", {
				text: "All book covers look fine.",
			});
			this.addClose();
			return;
		}

		const counts = new Map<string, number>();
		issues.forEach((issue) =>
			counts.set(issue.category, (counts.get(issue.category) ?? 0) + 1),
		);

		contentEl.createEl("p", {
			text: `Found ${issues.length} issue(s). Auditing covers under ${
				this.plugin.settings.coverDownloadLocation ||
				`${this.plugin.settings.targetFolderPath || "."}/cover`
			}.`,
		});

		const categoryLabels: Record<string, string> = {
			missing: "Cover file is missing",
			outside: "Cover lives outside the cover folder",
			remote: "Cover still a Goodreads URL (not downloaded)",
			none: "No cover property at all",
		};

		for (const category of ["missing", "outside", "remote", "none"]) {
			const group = issues.filter((issue) => issue.category === category);
			if (group.length === 0) continue;

			const fieldset = contentEl.createEl("fieldset");
			fieldset.addClass("booksidian-plugin__duplicate-group");
			fieldset.createEl("legend", {
				text: `${categoryLabels[category]} (${group.length})`,
			});

			group.forEach((issue) => {
				const label = fieldset.createEl("label");
				label.addClass("booksidian-plugin__duplicate-option");
				label.createSpan({
					text: `${issue.file.path} — ${issue.detail}`,
				});
			});
		}

		this.addClose();
	}

	private addClose(): void {
		const buttons = this.contentEl.createEl("div");
		buttons.addClass("booksidian-plugin__duplicate-buttons");
		new ButtonComponent(buttons)
			.setButtonText("Close")
			.onClick(() => this.close());
	}

	public onClose(): void {
		this.contentEl.empty();
	}
}

export function showCoverAuditSummary(plugin: Booksidian): void {
	const issues = findCoverIssues(plugin);
	new Notice(
		issues.length === 0
			? "Booksidian: all book covers look fine."
			: `Booksidian: ${issues.length} cover issue(s) found - run "Find books with missing covers" for details.`,
		6000,
	);
}
