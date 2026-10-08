/**
 * Minimal stub of the "obsidian" module for jest. The real package
 * ships types only (`main: ""`), sotests cannot resolve it. Any
 * unknown export becomes an stub class; function-shaped APIs that are
 * invoked at module scope (`debounce`) get working implementations.
 */
const cache = Object.create(null);

function stubClass(name) {
	const Stub = function Stub() {};
	Object.defineProperty(Stub, "name", { value: name });
	return Stub;
}

module.exports = new Proxy(module.exports, {
	get(target, prop, receiver) {
		if (prop === "__esModule") return true;
		if (typeof prop !== "string") return Reflect.get(target, prop, receiver);

		if (prop === "debounce") {
			return (callback) => callback;
		}

		if (!(prop in cache)) {
			cache[prop] = stubClass(prop);
		}
		return cache[prop];
	},
});
