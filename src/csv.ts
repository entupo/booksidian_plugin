import { GoodreadsBook } from "const/goodreads";

/**
 * Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (`""`),
 * embedded commas and newlines, and CRLF line endings. Goodreads
 * reviews routinely contain commas and multi-line text.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;

	const input = text.replace(/^\uFEFF/, "");

	for (let i = 0; i < input.length; i++) {
		const char = input[i];

		if (inQuotes) {
			if (char === '"') {
				if (input[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"' && field === "") {
			inQuotes = true;
		} else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (char !== "\r") {
			// Mid-field quotes are literal: Goodreads exports
			// Excel-style values like `="0439023483"`.
			field += char;
		}
	}

	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows;
}

/**
 * Goodreads exports ISBNs and ids Excel-style as `="0439023483"`.
 * Unwrap those and treat a lone `=""` as empty.
 */
export function cleanCell(value: string | undefined): string {
	if (value === undefined) return "";
	const trimmed = value.trim();
	const excel = trimmed.match(/^="(.*)"$/);
	if (excel) return excel[1].trim();
	return trimmed;
}

/**
 * Convert a Goodreads "My Books" CSV export into `GoodreadsBook`
 * objects accepted by the normal Book/frontmatter pipeline.
 */
export function goodreadsBooksFromCsv(text: string): GoodreadsBook[] {
	const rows = parseCsv(text);
	if (rows.length === 0) return [];

	const headers = rows[0].map((header) => header.trim().toLowerCase());
	const column = (row: string[], name: string): string => {
		const index = headers.indexOf(name.toLowerCase());
		return index === -1 ? "" : cleanCell(row[index]);
	};

	const books: GoodreadsBook[] = [];

	for (const row of rows.slice(1)) {
		if (row.every((cell) => cleanCell(cell) === "")) continue;

		const id = column(row, "Book Id");
		const title = column(row, "Title");
		const author = column(row, "Author");
		if (!id || !title) continue;

		const isbn13 = column(row, "ISBN13");
		const isbn10 = column(row, "ISBN");
		const shelves = column(row, "Bookshelves");
		const exclusiveShelf = column(row, "Exclusive Shelf");
		const year =
			column(row, "Original Publication Year") ||
			column(row, "Year Published");

		books.push({
			author,
			title,
			link: `https://www.goodreads.com/book/show/${id}`,
			pubDate: "",
			isbn: isbn13 || isbn10,
			user_review: column(row, "My Review"),
			book_description: "",
			user_rating: column(row, "My Rating") || "0",
			average_rating: column(row, "Average Rating") || "0",
			user_read_at: column(row, "Date Read"),
			user_date_added: column(row, "Date Added"),
			user_date_created: column(row, "Date Added"),
			book_published: year,
			identifiers: {
				$: { id },
				num_pages: [column(row, "Number of Pages")],
			},
			content: "",
			contentSnippet: "",
			guid: "",
			user_shelves: shelves || exclusiveShelf,
			image_url: "",
			image_path: "",
		});
	}

	return books;
}
