Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let _tiptap_core = require("@tiptap/core");
let _tiptap_pm_model = require("@tiptap/pm/model");
//#region src/getHTMLFromFragment.ts
/**
* Returns the HTML string representation of a given document node.
*
* @param doc - The document node to serialize.
* @param schema - The Prosemirror schema to use for serialization.
* @returns The HTML string representation of the document fragment.
*
* @example
* ```typescript
* const html = getHTMLFromFragment(doc, schema)
* ```
*/
function getHTMLFromFragment(doc, schema, options) {
	if (typeof window === "undefined") throw new Error("getHTMLFromFragment can only be used in a browser environment\nIf you want to use this in a Node environment, use the `@tiptap/html/server` import instead.");
	if (options === null || options === void 0 ? void 0 : options.document) {
		const wrap = options.document.createElement("div");
		_tiptap_pm_model.DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: options.document }, wrap);
		return wrap.innerHTML;
	}
	const wrap = window.document.createElement("div");
	_tiptap_pm_model.DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: window.document }, wrap);
	return wrap.innerHTML;
}
//#endregion
//#region src/generateHTML.ts
/**
* Generates HTML from a ProseMirror JSON content object.
* @param doc - The ProseMirror JSON content object.
* @param extensions - The Tiptap extensions used to build the schema.
* @returns The generated HTML string.
* @example
* const doc = {
*   type: 'doc',
*   content: [
*     {
*       type: 'paragraph',
*       content: [
*         {
*           type: 'text',
*           text: 'Hello world!'
*         }
*       ]
*     }
*   ]
* }
* const extensions = [...]
* const html = generateHTML(doc, extensions)
*/
function generateHTML(doc, extensions) {
	if (typeof window === "undefined") throw new Error("generateHTML can only be used in a browser environment\nIf you want to use this in a Node environment, use the `@tiptap/html/server` import instead.");
	const schema = (0, _tiptap_core.getSchema)(extensions);
	return getHTMLFromFragment(_tiptap_pm_model.Node.fromJSON(schema, doc), schema);
}
//#endregion
//#region src/generateJSON.ts
/**
* Generates a JSON object from the given HTML string and converts it into a Prosemirror node with content.
* @param {string} html - The HTML string to be converted into a Prosemirror node.
* @param {Extensions} extensions - The extensions to be used for generating the schema.
* @param {ParseOptions} options - The options to be supplied to the parser.
* @returns {Record<string, any>} - The generated JSON object.
* @example
* const html = '<p>Hello, world!</p>'
* const extensions = [...]
* const json = generateJSON(html, extensions)
* console.log(json) // { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello, world!' }] }] }
*/
function generateJSON(html, extensions, options) {
	if (typeof window === "undefined") throw new Error("generateJSON can only be used in a browser environment\nIf you want to use this in a Node environment, use the `@tiptap/html/server` import instead.");
	const schema = (0, _tiptap_core.getSchema)(extensions);
	const doc = new window.DOMParser().parseFromString(html, "text/html");
	if (!doc) throw new Error("Failed to parse HTML string");
	return _tiptap_pm_model.DOMParser.fromSchema(schema).parse(doc.body, options).toJSON();
}
//#endregion
exports.generateHTML = generateHTML;
exports.generateJSON = generateJSON;

//# sourceMappingURL=index.cjs.map