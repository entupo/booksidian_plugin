import { FRONTMATTER_LINES } from "const/frontmatter";
import { CurrentYAML } from "const/settings";
import { Book } from "src/Book";
import slugify from "@sindresorhus/slugify";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require("js-yaml");

export class Frontmatter {
	constructor(
		public currentYAML: CurrentYAML,
		public book: Book,
	) {}

	public getFrontmatter(): string {
		return (
			FRONTMATTER_LINES +
			"\n" +
			this.getFrontmatterLines() +
			FRONTMATTER_LINES +
			"\n"
		);
	}

	private getFrontmatterLines(): string {
		return yaml.dump(getBookValues(this.book, this.currentYAML));
	}
}

type FrontmatterValue = number | string | string[];

/**
 * Compose the frontmatter values for `book` according to
 * `currentYAML`. Values that our logic cannot produce meaningfully
 * (missing book fields, `undefined`/`NaN` residue from templating)
 * are emitted as empty strings instead of junk such as
 * `series: Name` or `seriesName: seriesundefined`.
 */
export function getBookValues(
	book: Book,
	currentYAML: CurrentYAML,
): { [key: string]: FrontmatterValue } {
	const output: { [key: string]: FrontmatterValue } = {};

	Object.keys(currentYAML).forEach((key: string) => {
		const value = currentYAML[key];

		// `tags` is a static, custom field: it does not template
		// around a book property. Its dictionary value is a plain
		// comma-separated tag list (e.g. `Book, Reading`).
		if (key === "tags") {
			const customTags: string[] = value
				.split(",")
				.map((tag) => tag.trim().replace(/^#/, ""))
				.filter((tag) => tag.length > 0);

			if (Array.isArray(output["tags"])) {
				output["tags"] = (
					output["tags"] as string[]
				).concat(customTags);
			} else {
				output["tags"] = customTags;
			}
			return;
		}

		if (key === "shelves") {
			const [prefix = "", postfix = ""] = value.split(key);
			const tagsOrPropertyKey = prefix === "#" ? "tags" : key;
			const values: string[] = [];

			(book.shelves ?? []).slice().sort().forEach((shelf) => {
				const sanitisedValue =
					prefix === "#" ? slugify(shelf) : shelf;
				values.push(`${prefix}${sanitisedValue}${postfix}`);
			});

			if (Array.isArray(output[tagsOrPropertyKey])) {
				output[tagsOrPropertyKey] = (
					output[tagsOrPropertyKey] as string[]
				).concat(values);
			} else {
				output[tagsOrPropertyKey] = values;
			}
		} else {
			const { fieldKey, prefix, postfix } = resolveFieldTemplate(
				key,
				value,
			);
			const tagsOrPropertyKey = prefix === "#" ? "tags" : key;
			const rawValue =
				fieldKey === ""
					? undefined
					: (book as unknown as Record<string, unknown>)[
							fieldKey
						];
			const stringValue =
				rawValue === undefined || rawValue === null
					? ""
					: rawValue.toString();

			// Guard against junk produced when a templated field has
			// no real value. `book[key]` may be missing entirely (the
			// `undefined` variants) or carry a non-numeric residue
			// (NaN). Empty book fields must not leak template residue
			// such as the postfix in `series: "seriesName"` either.
			if (stringValue === "" || isJunkValue(stringValue)) {
				output[tagsOrPropertyKey] = "";
				return;
			}

			const sanitisedValue = prefix === "#" ? slugify(stringValue) : stringValue;

			if (Array.isArray(output[tagsOrPropertyKey])) {
				(output[tagsOrPropertyKey] as string[]).push(
					sanitisedValue.toString(),
				);
			} else if (prefix === "#") {
				output[tagsOrPropertyKey] = [
					`${prefix}${sanitisedValue}${postfix}`,
				];
			} else {
				// Numeric book properties (pages, rating, avgRating,
				// seriesNumber) are real numbers. Emit them unquoted by
				// keeping the number type instead of dumping a string
				// like `'4'` (js-yaml re-quotes numeric-looking strings
				// to preserve their type).
				output[tagsOrPropertyKey] =
					prefix === "" &&
					postfix === "" &&
					typeof rawValue === "number"
						? rawValue
						: `${prefix}${sanitisedValue}${postfix}`;
			}
		}
	});

	return output;
}

/**
 * Book properties a frontmatter template may reference. Keys of the
 * frontmatter dictionary normally are the book property itself; when a
 * row has been renamed to a custom YAML key (e.g. `image`), the
 * template resolves the source field by finding one of these names
 * inside the value (longest match first, so `coverImageName` wins over
 * `coverImage`).
 */
export const KNOWN_BOOK_FIELDS: string[] = [
	"id",
	"rawTitle",
	"fullTitle",
	"title",
	"series",
	"seriesName",
	"seriesNumber",
	"subtitle",
	"description",
	"author",
	"isbn",
	"review",
	"rating",
	"avgRating",
	"shelves",
	"dateAdded",
	"dateCreated",
	"dateRead",
	"datePublished",
	"cover",
	"coverImage",
	"coverImageName",
	"bookPage",
	"pages",
].sort((a, b) => b.length - a.length);

/**
 * Resolve the book field and prefix/postfix for a dictionary entry.
 * A template must contain the key itself (e.g. `[[coverImage]]` -> prefix
 * `[[`, postfix `]]`). If it does not (e.g. `[[image]]`), a renamed key
 * is resolved by locating a known book field inside the value instead.
 * Defaults missing split pieces to empty strings instead of dumping
 * `undefined` into the output.
 */
function resolveFieldTemplate(
	key: string,
	value: string,
): { fieldKey: string; prefix: string; postfix: string } {
	if (!KNOWN_BOOK_FIELDS.includes(key)) {
		const token = KNOWN_BOOK_FIELDS.find(
			(field) => value.includes(field),
		);
		if (token) {
			const [prefix = "", postfix = ""] = value.split(token);
			return { fieldKey: token, prefix, postfix };
		}
		return { fieldKey: "", prefix: "", postfix: "" };
	}

	const [prefix = "", postfix = ""] = value.split(key);
	return { fieldKey: key, prefix, postfix };
}

/**
 * Build frontmatter updates for the cover-related keys of the
 * dictionary (`coverImage`, `coverImageName`, including renamed keys
 * whose template references them). `coverImagePath` is the full path
 * of the downloaded cover, e.g. `Archives/Books/_covers/58152486.jpg`.
 */
export function buildCoverUpdates(
	currentYAML: CurrentYAML,
	coverImagePath: string,
): { [key: string]: FrontmatterValue } {
	const output: { [key: string]: FrontmatterValue } = {};
	const fileName = coverImagePath.split("/").pop();

	Object.keys(currentYAML).forEach((key: string) => {
		const { fieldKey, prefix, postfix } = resolveFieldTemplate(
			key,
			currentYAML[key],
		);
		if (fieldKey !== "coverImage" && fieldKey !== "coverImageName") {
			return;
		}
		const rawValue =
			fieldKey === "coverImage" ? coverImagePath : fileName;

		// Respect the template as inline text: it may be "", inside a
		// wikilink, or reference the other cover field (rare but legal,
		// e.g. coverImageName = "coverImageName.jpg").
		output[key] = `${prefix}${rawValue}${postfix}`;
	});

	return output;
}

function isJunkValue(value: string): boolean {
	return (
		value === "NaN" || value === "undefined" || value.includes("undefined")
	);
}

/**
 * Return `content` with its leading frontmatter block removed. If there is
 * no leading `---` fence, or the opening fence has no matching closing
 * fence (malformed), `content` is returned unchanged so body data is never
 * destroyed.
 */
export function stripFrontmatter(content: string): string {
	const opening = FRONTMATTER_LINES + "\n";
	if (!content.startsWith(opening)) return content;

	const lines = content.split("\n");
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === FRONTMATTER_LINES) {
			return lines.slice(i + 1).join("\n");
		}
	}
	return content;
}

/**
 * Parse the leading frontmatter block of `content` into a plain
 * object. Uses the JSON schema so YAML dates and quoted scalars stay
 * strings (`created: 2026-10-08T11:32` must not become a Date and be
 * re-dumped modulo seconds). Returns `null` when the file has no
 * frontmatter block or the block does not parse, in which case it is
 * not safe to merge and callers should fall back to regenerating the
 * generated frontmatter like before.
 */
export function parseFrontmatter(
	content: string,
): Record<string, unknown> | null {
	const opening = FRONTMATTER_LINES + "\n";
	if (!content.startsWith(opening)) return null;

	const lines = content.split("\n");
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === FRONTMATTER_LINES) {
			const block = lines.slice(1, i).join("\n");
			try {
				const parsed = yaml.load(block, {
					schema: yaml.JSON_SCHEMA,
				});
				if (
					parsed &&
					typeof parsed === "object" &&
					!Array.isArray(parsed)
				) {
					return parsed as Record<string, unknown>;
				}
				return null;
			} catch (error) {
				console.log("Error parsing frontmatter", error);
				return null;
			}
		}
	}
	return null;
}

/**
 * Merge `updates` over `existing`, keeping every existing key at its
 * original position so untouched fields (status, tags, citekey,
 * created/modified, ...) survive a sync verbatim. Keys only known to
 * the frontmatter dictionary are appended at the end. The result is
 * dumped with flow-level arrays so `tags: [A, B]` stays single-line.
 */
export function mergeFrontmatter(
	existing: Record<string, unknown>,
	updates: Record<string, FrontmatterValue>,
): string {
	const merged: Record<string, unknown> = {};

	for (const key of Object.keys(existing)) {
		merged[key] = existing[key];
	}
	for (const key of Object.keys(updates)) {
		merged[key] = updates[key];
	}

	return yaml.dump(merged, { flowLevel: 1 });
}

/**
 * Wrap a dumped YAML body in frontmatter fences, mirroring what
 * `Frontmatter.getFrontmatter()` produces.
 */
export function formatFrontmatter(dumpedYaml: string): string {
	return FRONTMATTER_LINES + "\n" + dumpedYaml + FRONTMATTER_LINES + "\n";
}

/**
 * Frontmatter dump for duplicate merging: keep the survivor's keys in
 * place, add keys that only the losing notes carry, dump arrays
 * single-line.
 */
export function mergeUnknownKeys(
	existing: Record<string, unknown>,
	extra: Record<string, unknown>,
): string {
	const merged: Record<string, unknown> = {};

	for (const key of Object.keys(existing)) {
		merged[key] = existing[key];
	}
	for (const key of Object.keys(extra)) {
		merged[key] = extra[key];
	}

	return yaml.dump(merged, { flowLevel: 1 });
}
