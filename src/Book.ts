import { TFile, Notice } from "obsidian";
import { CurrentYAML } from "const/settings";
import { GoodreadsBook } from "const/goodreads";
import Booksidian from "main";
import { Body } from "./Body";
import {
	Frontmatter,
	getBookValues,
	parseFrontmatter,
	mergeFrontmatter,
	formatFrontmatter,
	stripFrontmatter,
} from "./Frontmatter";
import { writeFile } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TurndownService = require("turndown");

/**
 * Frontmatter keys that are mapped to the Goodreads book id by the
 * frontmatter dictionary (e.g. an entry `"id": "id"` yields `["id"]`).
 * Used both for matching an existing note by id during sync and for
 * finding duplicates.
 */
export function getIdKeys(frontmatterDictionary: CurrentYAML): string[] {
	return Object.entries(frontmatterDictionary)
		.filter(([, bookField]) => bookField === "id")
		.map(([frontmatterKey]) => frontmatterKey);
}

export class Book {
	id: string;
	pages: number;
	title: string;
	rawTitle: string;
	fullTitle: string;
	series: string;
	seriesName: string;
	seriesNumber: number;
	subtitle: string;
	description: string;
	author: string;
	isbn: string;
	review: string;
	rating: number;
	avgRating: number;
	shelves: string[];
	dateAdded: string;
	dateCreated: string;
	dateRead: string;
	datePublished: string;
	cover: string;
	coverImage: string;
	bookPage: string;

	constructor(
		public plugin: Booksidian,
		book: GoodreadsBook,
	) {
		this.id = book.identifiers.$.id;
		this.pages = parseInt(book.identifiers.num_pages[0]) || undefined;
		this.title = this.cleanTitle(book.title, false);
		this.rawTitle = book.title;
		this.fullTitle = this.cleanTitle(book.title, true);
		this.description = this.htmlToMarkdown(book.book_description);
		this.author = book.author;
		this.isbn = book.isbn;
		this.review = this.htmlToMarkdown(book.user_review || "");
		this.rating = parseInt(book.user_rating) || 0;
		this.avgRating = parseFloat(book.average_rating) || 0;
		this.dateAdded = this.parseDate(book.user_date_added);
		this.dateCreated = this.parseDate(book.user_date_created);
		this.dateRead = this.parseDate(book.user_read_at);
		this.datePublished = this.parseDate(book.book_published);
		this.cover = book.image_url;
		this.coverImage = book.image_path;
		this.shelves = this.getShelves(book.user_shelves, this.dateRead);
		this.bookPage = `https://www.goodreads.com/book/show/${this.id}`;
	}

	public getTitle(): string {
		return this.title;
	}

	public getContent(): string {
		const set = this.plugin.settings;
		try {
			return (
				this.getFrontMatter(set.frontmatterDictionary) +
				this.getBody(set.bodyString)
			);
		} catch (error) {
			console.log(error);
		}
	}

	private htmlToMarkdown(html: string) {
		const turndownService = new TurndownService();
		return turndownService.turndown(html);
	}

	private getShelves(shelves: string, dateRead: string): string[] {
		// Goodreads doesn't send a shelf value for books on the read shelf.
		// Infer from either a missing shelf value, or a set dateRead.
		// Check for presence of read first in case Goodreads decides to include it.
		const outputShelves = shelves
			.split(",")
			.map((shelf) => shelf.trim()) // trim shelf names
			.filter((shelf) => shelf); // filter out empty shelf names

		// If the book has a read date and the `read` shelf is missing, we add it
		if (dateRead && !outputShelves.includes("read"))
			outputShelves.push("read");

		return outputShelves;
	}

	private getBody(currentBody: string): string {
		return new Body(currentBody, this).getBody();
	}

	private getFrontMatter(currentYAML: CurrentYAML): string {
		if (Object.keys(currentYAML).length > 0) {
			return new Frontmatter(currentYAML, this).getFrontmatter();
		}
		return "";
	}

	public async createFile(book: Book, path: string): Promise<void> {
		const fileName = this.getBody(this.plugin.settings.fileName);
		const fullPath = `${path}/${fileName}.md`;

		let file = this.plugin.app.vault.getFileByPath(fullPath);

		// Fall back to matching any note in the vault whose frontmatter
		// id equals the Goodreads id, so lore notes living outside the
		// target folder (e.g. ZotLit literature notes) are updated in
		// place instead of duplicated under the title-derived filename.
		if (!file && this.plugin.settings.useIdMatch) {
			const match = this.resolveNotesById(book.id, path);
			if (match) {
				file = match.file;
				const extra = match.otherPaths.length
					? ` (other matches: ${match.otherPaths.join(", ")})`
					: "";
				new Notice(
					`Booksidian: updated "${book.title}" at ${file.path} (Goodreads id match)${extra}`,
					5000,
				);
			}
		}

		if (file) {
			if (!this.plugin.settings.overwrite) return;

			if (file.path === fullPath && !this.plugin.settings.overwritePreserveBody) {
				writeFile(fullPath, book.getContent(), this.plugin.app);
				return;
			}

			await this.updateExistingFile(book, file);
			return;
		}

		const bookContent = book.getContent();

		writeFile(fullPath, bookContent, this.plugin.app);
	}

	/**
	 * Find markdown files anywhere in the vault whose frontmatter id
	 * equals `bookId`. Notes inside the target folder sort first so a
	 * Booksidian-created note wins ties; anything else (e.g. a ZotLit
	 * note in `Projects/`) is still matched when no in-folder note
	 * exists. Returns the preferred note and the other paths that also
	 * matched, which callers surface as a duplicate warning.
	 */
	private resolveNotesById(
		bookId: string,
		path: string,
	): { file: TFile; otherPaths: string[] } | null {
		const notes = this.findNotesById(bookId);
		if (notes.length === 0) return null;

		const targetFolderPath = this.plugin.settings.targetFolderPath;
		const inTarget = (file: TFile): boolean => {
			if (!targetFolderPath) return file.path === path || file.path === `${path}/${file.name}`;
			return (
				file.path === targetFolderPath ||
				file.path.startsWith(`${targetFolderPath}/`)
			);
		};

		notes.sort((a, b) => Number(inTarget(b)) - Number(inTarget(a)));

		return {
			file: notes[0],
			otherPaths: notes.slice(1).map((note) => note.path),
		};
	}

	private findNotesById(bookId: string): TFile[] {
		const idKeys = getIdKeys(this.plugin.settings.frontmatterDictionary);
		if (idKeys.length === 0) return [];

		const matches: TFile[] = [];
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			const frontmatter = this.plugin.app.metadataCache.getFileCache(
				file,
			)?.frontmatter as Record<string, unknown> | undefined;
			if (!frontmatter) continue;

			const hasId = idKeys.some((key) => {
				const value = frontmatter[key];
				return (
					value !== undefined &&
					value !== null &&
					String(value) === String(bookId)
				);
			});
			if (hasId) matches.push(file);
		}
		return matches;
	}

	/**
	 * Update an existing note in place: the frontmatter dictionary
	 * fields are refreshed, every other frontmatter key and the whole
	 * note body are preserved. Used both for filename-matched notes
	 * (with "preserve body") and for notes matched by Goodreads id
	 * (always, since their body belongs to the note author).
	 */
	private async updateExistingFile(book: Book, file: TFile): Promise<void> {
		const existing = await this.plugin.app.vault.read(file);
		const frontmatter = parseFrontmatter(existing);

		let content: string;
		if (frontmatter) {
			const updates = getBookValues(
				book,
				this.plugin.settings.frontmatterDictionary,
			);
			const merged = formatFrontmatter(mergeFrontmatter(frontmatter, updates));
			content = merged + stripFrontmatter(existing);
		} else {
			// No parseable frontmatter: fall back to the previous
			// regenerate-everything behavior.
			const newFrontmatter = this.getFrontMatter(
				this.plugin.settings.frontmatterDictionary,
			);
			content = newFrontmatter + stripFrontmatter(existing);
		}

		writeFile(file.path, content, this.plugin.app);
	}

	private cleanTitle(title: string, full: boolean) {
		this.series = "";
		this.seriesName = "";
		this.seriesNumber = 0;
		this.subtitle = "";
		let series = "";

		if (title.includes("(") && title.includes("#")) {
			series = this.getSeries(title);
		}

		title = title.replace(series, "");

		if (title.includes(":")) {
			this.getSubTitle(title);
		}

		if (!full) {
			title = title.split(":")[0];
		}

		// replace remaining special characters with an empty character
		title = title.replace(/[&/\\#,+()$~%.'":*?<>{}|]/g, "");

		return title.trim();
	}

	private getSeries(title: string): string {
		// only calculate once per book
		if (this.series) {
			return this.series;
		}
		let match = title.match(/.+ \(((.+?),? #(\d+))\)/);

		if (match) {
			this.series = match[1].trim();
			this.seriesName = match[2].trim();
			this.seriesNumber = parseInt(match[3].trim(), 10);
			return `(${match[1]})`;
		}

		console.log(
			`New get series parser failed for "${title}", falling back to legacy parser.`,
		);

		// fallback to old method, this is mostly for backwards compatibility in case of edge cases
		match = title.match(/\((.*?)\)/);
		if (match && match[1].contains("#")) {
			this.series = match[1].trim();
			return match[0];
		}
		return "";
	}

	private getSubTitle(title: string) {
		this.subtitle = title.split(":")[1].trim();
	}

	private parseDate(inputDate: string) {
		if (inputDate == "") {
			return "";
		}
		const date = new Date(inputDate);
		return date.toISOString().substring(0, 10);
	}
}
