import {
	getBookValues,
	mergeFrontmatter,
	parseFrontmatter,
	stripFrontmatter,
} from "src/Frontmatter";
import { Book } from "src/Book";
import { GoodreadsBook } from "const/goodreads";

describe("stripFrontmatter", () => {
	test("file with frontmatter and body: returns body byte-identical", () => {
		const existing = "---\ntitle: old\n---\n# Heading\n\nMy notes.\n";
		expect(stripFrontmatter(existing)).toBe("# Heading\n\nMy notes.\n");
	});

	test("file with frontmatter only (no body): returns empty string", () => {
		expect(stripFrontmatter("---\ntitle: old\n---\n")).toBe("");
	});

	test("file with no frontmatter: returns content unchanged", () => {
		const existing = "Just some body text.\n";
		expect(stripFrontmatter(existing)).toBe(existing);
	});

	test("empty file: returns empty string", () => {
		expect(stripFrontmatter("")).toBe("");
	});

	test("body containing --- horizontal rules: only leading frontmatter block is stripped", () => {
		const existing =
			"---\ntitle: old\n---\nIntro\n\n---\n\nAfter rule\n";
		expect(stripFrontmatter(existing)).toBe(
			"Intro\n\n---\n\nAfter rule\n",
		);
	});

	test("malformed: opening --- with no closing --- returns content unchanged", () => {
		const existing = "---\ntitle: old\nno closing fence here\n";
		expect(stripFrontmatter(existing)).toBe(existing);
	});
});

function makeBook(overrides: Partial<GoodreadsBook> = {}): Book {
	const base: GoodreadsBook = {
		author: "Tony Reinke",
		title: "God Technology and the Christian Life",
		link: "link",
		pubDate: "",
		isbn: "1433578271",
		user_rating: "0",
		user_review: "",
		book_description: "",
		average_rating: "3",
		user_read_at: "",
		user_date_added: "",
		user_date_created: "",
		book_published: "01/01/2021",
		identifiers: { $: { id: "58152486" }, num_pages: ["316"] },
		content: "",
		contentSnippet: "",
		guid: "",
		user_shelves: "",
		image_url: "",
		image_path: "Archives/Books/_covers/58152486.jpg",
	};
	return new Book(null, { ...base, ...overrides });
}

describe("getBookValues", () => {
	test("dictionary fields compose from the matching book properties", () => {
		const values = getBookValues(makeBook(), {
			id: "id",
			author: "author",
			isbn: "isbn",
			bookPage: "bookPage",
			rating: "rating",
		});
		expect(values).toStrictEqual({
			id: "58152486",
			author: "Tony Reinke",
			isbn: "1433578271",
			bookPage: "https://www.goodreads.com/book/show/58152486",
			rating: "0",
		});
	});

	test("wikilink values wrap the book value", () => {
		const values = getBookValues(makeBook(), {
			coverImage: "[[coverImage]]",
		});
		expect(values).toStrictEqual({
			coverImage: "[[Archives/Books/_covers/58152486.jpg]]",
		});
	});

	test("missing book field produces an empty string, not undefined junk", () => {
		const values = getBookValues(makeBook(), { description: "description" });
		expect(values).toStrictEqual({ description: "" });
	});

	test("empty book value does not leak the dictionary template residue", () => {
		// `series: "seriesName"` previously produced `series: Name` for
		// books without a series.
		const values = getBookValues(makeBook(), { series: "seriesName" });
		expect(values).toStrictEqual({ series: "" });
	});

	test("NaN residue from templating is emitted as empty string", () => {
		const values = getBookValues(makeBook(), { rating: "rating" });
		expect(values.rating).toBe("0");
	});
});

describe("parseFrontmatter", () => {
	test("parses scalar fields, keeping dates as strings", () => {
		const parsed = parseFrontmatter(
			"---\ncreated: 2026-10-08T11:32\nid: '58152486'\npages: 316\ntitle: God, Technology, and the Christian Life\n---\n# Body\n",
		);
		expect(parsed).toStrictEqual({
			created: "2026-10-08T11:32",
			id: "58152486",
			pages: 316,
			title: "God, Technology, and the Christian Life",
		});
	});

	test("parses single-line arrays", () => {
		const parsed = parseFrontmatter(
			"---\ntags: [Book, Journal/Reading]\n---\n",
		);
		expect(parsed).toEqual({ tags: ["Book", "Journal/Reading"] });
	});

	test("returns null for missing, malformed, or non-map frontmatter", () => {
		expect(parseFrontmatter("No frontmatter\n")).toBeNull();
		expect(parseFrontmatter("---\nno closing fence\n")).toBeNull();
		expect(parseFrontmatter("---\nid\n---\n")).toBeNull();
	});
});

describe("mergeFrontmatter", () => {
	test("updates dictionary keys in place and preserves all other keys verbatim", () => {
		const existing = {
			title: "God, Technology, and the Christian Life",
			status: "active",
			created: "2026-09-10T11:39",
			modified: "2026-10-05T12:01",
			citekey: "Reinke2022",
			id: "stale",
			dateRead: "2021-01-01",
			rating: "0",
		};
		const updates = { id: "58152486", dateRead: "", rating: "0" };
		const dumped = mergeFrontmatter(existing, updates);

		const merged = parseFrontmatter(
			`---\n${dumped}---\nbody stays\n`,
		) as Record<string, unknown>;

		expect(merged.id).toBe("58152486");
		expect(merged.dateRead).toBe("");
		expect(merged.title).toBe("God, Technology, and the Christian Life");
		expect(merged.status).toBe("active");
		expect(merged.citekey).toBe("Reinke2022");
		expect(merged.created).toBe("2026-09-10T11:39");
	});

	test("appends dictionary keys that are new", () => {
		const dumped = mergeFrontmatter({ status: "active" }, { rating: "0" });
		expect(dumped).toContain("status: active\n");
		expect(dumped).toContain("rating: '0'\n");
	});

	test("dumps arrays flow/single-line", () => {
		const dumped = mergeFrontmatter(
			{ tags: ["Book", "Journal/Reading"] },
			{},
		);
		expect(dumped).toContain("tags: [Book, Journal/Reading]");
	});
});
