import { Notice, TFile } from "obsidian";
import { isAbsolute, dirname } from "path";
import * as nodeFs from "fs";
import { get } from "https";
import Booksidian from "main";
import { getIdKeys } from "src/Book";
import {
	buildCoverUpdates,
	formatFrontmatter,
	mergeFrontmatter,
	parseFrontmatter,
	stripFrontmatter,
} from "src/Frontmatter";
import { writeFile } from "src/helpers";

/**
 * Download one cover and return the image path as it should appear in
 * frontmatter (relative to the vault when applicable).
 */
export async function downloadCover(
	plugin: Booksidian,
	url: string,
	bookId: string,
): Promise<string> {
	const folder =
		plugin.settings.coverDownloadLocation.trim() !== ""
			? plugin.settings.coverDownloadLocation
			: `${plugin.settings.targetFolderPath || "."}/cover`;
	const fullPath = `${folder}/${bookId}.jpg`;

	if (existsOnDisk(plugin, fullPath)) return fullPath;

	const chunks: Buffer[] = [];
	await new Promise<void>((resolve, reject) => {
		const request = get(url, (response) => {
			response.setEncoding("binary");
			response.on("data", (chunk: string) =>
				chunks.push(Buffer.from(chunk, "binary")),
			);
			response.on("end", resolve);
			response.on("error", reject);
		});
		request.on("error", reject);
	});
	const image = Buffer.concat(chunks);

	if (isAbsolute(fullPath)) {
		nodeFs.mkdirSync(dirname(fullPath), { recursive: true });
		nodeFs.writeFileSync(fullPath, image);
	} else {
		if (!(await plugin.app.vault.adapter.exists(folder))) {
			await plugin.app.vault.createFolder(folder);
		}
		await plugin.app.vault.adapter.writeBinary(fullPath, image);
	}

	return fullPath;
}

/**
 * `true` when the file exists on disk, whether inside or outside the
 * vault. Relative paths are resolved against the vault root.
 */
function existsOnDisk(plugin: Booksidian, path: string): boolean {
	if (isAbsolute(path)) {
		return nodeFs.existsSync(path);
	}
	return plugin.app.vault.getAbstractFileByPath(path) !== null;
}

/**
 * Command entry point: download the cover for the note in the active
 * editor, then refresh the note's cover frontmatter properties
 * (including renamed keys) while leaving everything else untouched.
 */
export async function refreshCoverForActiveNote(
	plugin: Booksidian,
): Promise<void> {
	const file: TFile | null = plugin.app.workspace.getActiveFile();
	if (!file || file.extension !== "md") {
		new Notice("Booksidian: open a book note first.");
		return;
	}

	const content = await plugin.app.vault.read(file);
	const frontmatter = parseFrontmatter(content);
	if (!frontmatter) {
		new Notice("Booksidian: could not parse this note's frontmatter.");
		return;
	}

	const idKeys = getIdKeys(plugin.settings.frontmatterDictionary);
	const bookId = idKeys
		.map((key) => String(frontmatter[key] ?? ""))
		.find((value) => value !== "");
	if (!bookId) {
		new Notice(
			"Booksidian: this note has no Goodreads id in its frontmatter.",
		);
		return;
	}

	let coverUrl: string | null = null;
	for (const key of Object.keys(frontmatter)) {
		const value = frontmatter[key];
		if (typeof value !== "string") continue;
		if (/^https?:\/\/\S+\.(jpe?g|png|gif|webp)(\?.*)?$/i.test(value)) {
			coverUrl = value;
			break;
		}
	}
	if (!coverUrl) {
		new Notice(
			"Booksidian: this note has no remote cover URL. Add a `cover` property with the Goodreads image URL first.",
		);
		return;
	}

	try {
		const fullPath = await downloadCover(plugin, coverUrl, bookId);
		const coverUpdates = buildCoverUpdates(
			plugin.settings.frontmatterDictionary,
			fullPath,
		);

		const merged = mergeFrontmatter(frontmatter, coverUpdates);
		await writeFile(
			file.path,
			formatFrontmatter(merged) + stripFrontmatter(content),
			plugin.app,
		);

		new Notice(`Booksidian: cover saved to ${fullPath}`, 5000);
	} catch (error) {
		console.log("Booksidian: cover download failed", error);
		new Notice("Booksidian: cover download failed. See console/log.");
	}
}
