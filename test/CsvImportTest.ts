import { cleanCell, goodreadsBooksFromCsv, parseCsv } from "src/csv";

const HEADER =
	"Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies";

describe("parseCsv", () => {
	test("parses quoted fields with commas, newlines and escaped quotes", () => {
		const rows = parseCsv(
			'id,title,review\n1,"Dune, Book One","Line one\nLine two ""quoted"""\n2,Emma,',
		);
		expect(rows).toStrictEqual([
			["id", "title", "review"],
			["1", "Dune, Book One", 'Line one\nLine two "quoted"'],
			["2", "Emma", ""],
		]);
	});

	test("strips a UTF-8 BOM", () => {
		expect(parseCsv("\uFEFFa,b\n1,2")).toStrictEqual([
			["a", "b"],
			["1", "2"],
		]);
	});
});

describe("cleanCell", () => {
	test("unwraps the Excel-style ISBN wrapper", () => {
		expect(cleanCell('="0439023483"')).toBe("0439023483");
		expect(cleanCell('=""')).toBe("");
		expect(cleanCell(" plain ")).toBe("plain");
		expect(cleanCell(undefined)).toBe("");
	});
});

describe("goodreadsBooksFromCsv", () => {
	const row = [
		'="54493401"',
		"Machine Vendetta",
		"Alastair Reynolds",
		"Reynolds, Alastair",
		"",
		'="0575090940"',
		'="9780575090944"',
		"4",
		"4.10",
		"Gollancz",
		"Hardcover",
		"416",
		"2024",
		"2024",
		"2026/11/08",
		"2026/01/02",
		"currently-reading, favorites",
		"currently-reading (#1), favorites (#2)",
		"currently-reading",
		"Great so far, second in the series.",
		"No",
		"",
		"1",
		"0",
	]
		.map((cell) => (cell.includes(",") ? `"${cell}"` : cell))
		.join(",");

	test("maps Goodreads columns onto the Book pipeline shape", () => {
		const books = goodreadsBooksFromCsv(`${HEADER}\n${row}\n${row}\n`);
		expect(books).toHaveLength(2);

		expect(books[0]).toStrictEqual({
			author: "Alastair Reynolds",
			title: "Machine Vendetta",
			link: "https://www.goodreads.com/book/show/54493401",
			pubDate: "",
			isbn: "9780575090944",
			user_review: "Great so far, second in the series.",
			book_description: "",
			user_rating: "4",
			average_rating: "4.10",
			user_read_at: "2026/11/08",
			user_date_added: "2026/01/02",
			user_date_created: "2026/01/02",
			book_published: "2024",
			identifiers: {
				$: { id: "54493401" },
				num_pages: ["416"],
			},
			content: "",
			contentSnippet: "",
			guid: "",
			user_shelves: "currently-reading, favorites",
			image_url: "",
			image_path: "",
		});
	});

	test("read books keep the exclusive shelf alongside custom shelves", () => {
		const readRow = [
			'="54493401"',
			"Machine Vendetta",
			"Alastair Reynolds",
			"",
			"",
			'="0575090940"',
			'="9780575090944"',
			"0",
			"4.10",
			"",
			"",
			"416",
			"2024",
			"2024",
			"",
			"2026/01/02",
			"favorites",
			"",
			"read",
			"",
			"",
			"",
			"0",
			"0",
		]
			.map((cell) => (cell.includes(",") ? `"${cell}"` : cell))
			.join(",");
		const books = goodreadsBooksFromCsv(`${HEADER}\n${readRow}\n`);
		expect(books[0].user_shelves).toBe("favorites, read");
	});

	test("skips rows without an id or title", () => {
		const books = goodreadsBooksFromCsv(
			`${HEADER}\n,No Id,,,,,,,,,,,,,,,,,,,,\n`,
		);
		expect(books).toStrictEqual([]);
	});
});
