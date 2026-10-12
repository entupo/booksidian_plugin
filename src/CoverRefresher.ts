import { Notice, TFile } from "obsidian";
import { isAbsolute, dirname } from "path";
import * as nodeFs from "fs";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import { IncomingHttpHeaders, IncomingMessage } from "http";
import Booksidian from "main";
import { getIdKeys } from "src/Book";
import {
	buildCoverUpdates,
	formatFrontmatter,
	mergeFrontmatter,
	resolveFieldTemplate,
	parseFrontmatter,
	stripFrontmatter,
} from "src/Frontmatter";
import { writeFile } from "src/helpers";

interface FetchedResource {
	status: number;
	contentType: string;
	buffer: Buffer;
	finalUrl: string;
}

/**
 * GET `url`, following up to `maxHops` redirects, and return status,
 * content type and the raw body.
 */
async function fetchUrl(url: string, maxHops = 5): Promise<FetchedResource> {
	for (let hop = 0; hop < maxHops; hop++) {
		const response = await new Promise<IncomingMessage>(
			(resolve, reject) => {
				const doRequest = url.startsWith("http://")
					? httpGet
					: httpsGet;
				const request = doRequest(url, (result) => resolve(result));
				request.on("error", reject);
			},
		);

		const status = response.statusCode ?? 0;
		const location = response.headers.location;
		if (status >= 300 && status < 400 && location) {
			url = new URL(location, url).toString();
			continue;
		}

		return {
			status,
			contentType: String(response.headers["content-type"] ?? ""),
			buffer: await readBody(response),
			finalUrl: url,
		};
	}
	throw new Error(`too many redirects fetching ${url}`);
}

function readBody(response: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		response.setEncoding("binary");
		response.on("data", (chunk: string) =>
			chunks.push(Buffer.from(chunk, "binary")),
		);
		response.on("end", () => resolve(Buffer.concat(chunks)));
		response.on("error", reject);
	});
}

export function scrapeOgImageUrl(html: string): string | null {
	const candidates: string[] = [
		html.match(
			/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
		)?.[1],
		html.match(
			/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
		)?.[1],
	]?.filter(
		(url): url is string => typeof url === "string",
	) ?? [];

	// Anonymous Goodreads pages surface the site icon as og:image;
	// that is never a book cover.
	return (
		candidates.find(
			(url) =>
				/^https?:\/\//i.test(url) &&
				!/\/assets\/(icons\/)?goodreads_icon/i.test(url),
		) ?? null
	);
}

/**
 * Resolve a Goodreads photo page (any URL chain) into raw image
 * bytes, following redirects and scraping og:image from HTML pages.
 */
async function fetchCoverImage(requestUrl: string): Promise<Buffer> {
	let url = requestUrl;

	for (let hop = 0; hop < 5; hop++) {
		const resource = await fetchUrl(url);

		if (resource.status === 200 && resource.contentType.startsWith("image/")) {
			return resource.buffer;
		}

		const scraped = scrapeOgImageUrl(
			resource.buffer.toString("binary"),
		);
		if (!scraped) {
			throw new Error(
				`could not fetch cover: ${resource.status} ${resource.contentType} at ${resource.finalUrl}`,
			);
		}
		url = scraped;
	}

	throw new Error(
		`could not fetch cover image after redirects: ${url}`,
	);
}

/**
 * Open Library has an exact-ISBN cover endpoint; `default=false` makes
 * missing covers return 404 instead of a placeholder image.
 */
async function fetchOpenLibraryCover(isbn: string): Promise<Buffer> {
	const resource = await fetchUrl(
		`https://covers.openlibrary.org/b/isbn/${encodeURIComponent(
			isbn.replace(/[-\s]/g, ""),
		)}-L.jpg?default=false`,
	);
	if (resource.status === 200 && resource.contentType.startsWith("image/")) {
		return resource.buffer;
	}
	throw new Error(
		`Open Library has no cover for ISBN ${isbn} (${resource.status})`,
	);
}

/**
 * Google Books search returns cover thumbnails without any API key.
 * `q` is a `isbn:` or `intitle:/inauthor:` expression.
 */
async function fetchGoogleBooksCover(query: string): Promise<Buffer> {
	const resource = await fetchUrl(
		`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
			query,
		)}&maxResults=1`,
	);
	if (resource.status !== 200) {
		throw new Error(`Google Books search failed (${resource.status})`);
	}

	const data: {
		items?: {
			volumeInfo?: {
				imageLinks?: Record<string, string>;
			};
		}[];
	} = JSON.parse(resource.buffer.toString("utf8"));

	const imageLinks = data?.items?.[0]?.volumeInfo?.imageLinks ?? {};
	const thumbnail =
		imageLinks.thumbnail ?? imageLinks.smallThumbnail;
	if (!thumbnail) throw new Error("no Google Books cover found");

	// Thumbnails come http-only; Obsidian or the CDN may upgrade, but
	// https is always safe here.
	const imageUrl = thumbnail
		.replace("&edge=curl", "")
		.replace(/^http:\/\//i, "https://");
	return fetchCoverImage(imageUrl);
}

/**
 * Pull a cover for `bookId`, trying sources in order:
 * 1. a remote cover URL carried by the note (if any)
 * 2. Open Library via the note's ISBN
 * 3. Google Books via ISBN, else title/author
 * 4. the Goodreads photo page for the id
 * Returns the bytes and the label of the source that worked.
 */
export async function fetchCoverForBook(
	coverUrl: string | null,
	isbn: string | null,
	title: string | null,
	author: string | null,
	bookId: string,
): Promise<{ bytes: Buffer; source: string }> {
	let lastError: unknown = null;

	if (coverUrl) {
		try {
			return {
				bytes: await fetchCoverImage(coverUrl),
				source: "frontmatter cover URL",
			};
		} catch (error) {
			lastError = error;
			console.log("Booksidian: cover URL attempt failed", error);
		}
	}

	if (isbn) {
		try {
			return {
				bytes: await fetchOpenLibraryCover(isbn),
				source: `Open Library (ISBN ${isbn})`,
			};
		} catch (error) {
			lastError = error;
			console.log("Booksidian: Open Library attempt failed", error);
		}
	}

	if (isbn || title) {
		const query = isbn ? `isbn:${isbn}` : `intitle:${title} inauthor:${author}`;
		try {
			return {
				bytes: await fetchGoogleBooksCover(query),
				source: isbn ? "Google Books (ISBN)" : "Google Books (title/author)",
			};
		} catch (error) {
			lastError = error;
			console.log("Booksidian: Google Books attempt failed", error);
		}
	}

	return {
		bytes: await fetchCoverImage(
			`https://www.goodreads.com/book/photo/${bookId}`,
		),
		source: "Goodreads photo page",
	};
}

/**
 * Download one cover and return the image path as it should appear in
 * frontmatter (relative to the vault when applicable).
 */
export async function downloadCover(
	plugin: Booksidian,
	remoteUrl: string | null,
	isbn: string | null,
	title: string | null,
	author: string | null,
	bookId: string,
): Promise<string> {
	const folder =
		plugin.settings.coverDownloadLocation.trim() !== ""
			? plugin.settings.coverDownloadLocation
			: `${plugin.settings.targetFolderPath || "."}/cover`;
	const fullPath = `${folder}/${bookId}.jpg`;

	if (existsOnDisk(plugin, fullPath)) return fullPath;

	const { bytes } = await fetchCoverForBook(
		remoteUrl,
		isbn,
		title,
		author,
		bookId,
	);

	if (isAbsolute(fullPath)) {
		nodeFs.mkdirSync(dirname(fullPath), { recursive: true });
		nodeFs.writeFileSync(fullPath, bytes);
	} else {
		if (!(await plugin.app.vault.adapter.exists(folder))) {
			await plugin.app.vault.createFolder(folder);
		}
		await plugin.app.vault.adapter.writeBinary(fullPath, bytes);
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
 * The note's value for `bookField` using the dictionary mapping, so
 * renamed keys (e.g. `aliases: title`) still count.
 */
function noteValueForField(
	plugin: Booksidian,
	frontmatter: Record<string, unknown>,
	bookField: string,
): string | null {
	const fallback = frontmatter[bookField];
	if (typeof fallback === "string" && fallback.trim() !== "") {
		return fallback.trim();
	}

	for (const key of Object.keys(
		plugin.settings.frontmatterDictionary,
	)) {
		const { fieldKey } = resolveFieldTemplate(
			key,
			plugin.settings.frontmatterDictionary[key],
		);
		if (fieldKey === bookField) {
			const value = frontmatter[key];
			if (typeof value === "string" && value.trim() !== "") {
				return value.trim();
			}
		}
	}
	return null;
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

	// An explicit remote cover URL has priority; an ISBN (plain or
	// ISBN-10/13 shaped) enables Open Library/Google Books.
	let coverUrl: string | null = null;
	for (const key of Object.keys(frontmatter)) {
		const value = frontmatter[key];
		if (typeof value !== "string") continue;
		if (/^https?:\/\/\S+\.(jpe?g|png|gif|webp)(\?.*)?$/i.test(value)) {
			coverUrl = value;
			break;
		}
	}

	const isbn = noteValueForField(plugin, frontmatter, "isbn");
	const title = noteValueForField(plugin, frontmatter, "title");
	const author = noteValueForField(plugin, frontmatter, "author");

	try {
		const fullPath = await downloadCover(
			plugin,
			coverUrl,
			isbn,
			title,
			author,
			bookId,
		);
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
		new Notice("Booksidian: could not fetch a cover for this book. See console for details.");
	}
}
