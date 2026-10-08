module.exports = slugify;
module.exports.default = slugify;

/** Matches @sindresorhus/slugify output closely enough for tests. */
function slugify(input) {
	return String(input)
		.toLowerCase()
		.replace(/['\u2019]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
