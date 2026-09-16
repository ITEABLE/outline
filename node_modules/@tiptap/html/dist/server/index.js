import { getSchema } from "@tiptap/core";
import { DOMParser, DOMSerializer, Node } from "@tiptap/pm/model";
import { Window } from "happy-dom";
//#region src/server/getHTMLFromFragment.ts
/**
* Returns the HTML string representation of a given document node.
*
* @remarks **Important**: This function requires `happy-dom` to be installed in your project.
* @param doc - The document node to serialize.
* @param schema - The Prosemirror schema to use for serialization.
* @returns A promise containing the HTML string representation of the document fragment.
*
* @example
* ```typescript
* const html = getHTMLFromFragment(doc, schema)
* ```
*/
function getHTMLFromFragment(doc, schema, options) {
	if (options === null || options === void 0 ? void 0 : options.document) {
		const wrap = options.document.createElement("div");
		DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: options.document }, wrap);
		return wrap.innerHTML;
	}
	const localWindow = new Window({ settings: {
		disableJavaScriptEvaluation: true,
		disableJavaScriptFileLoading: true,
		disableCSSFileLoading: true,
		disableIframePageLoading: true,
		disableComputedStyleRendering: true
	} });
	let result;
	try {
		const wrap = localWindow.document.createElement("div");
		DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: localWindow.document }, wrap);
		result = wrap.innerHTML;
	} finally {
		localWindow.happyDOM.abort();
		localWindow.happyDOM.close();
	}
	return result;
}
//#endregion
//#region src/server/generateHTML.ts
/**
* This function generates HTML from a ProseMirror JSON content object.
*
* @remarks **Important**: This function requires `happy-dom` to be installed in your project.
* @param doc - The ProseMirror JSON content object.
* @param extensions - The Tiptap extensions used to build the schema.
* @returns The generated HTML string.
* @example
* ```js
* const html = generateHTML(doc, extensions)
* console.log(html)
* ```
*/
function generateHTML(doc, extensions) {
	if (!(typeof process !== "undefined" && process.versions != null && process.versions.node != null)) throw new Error("generateHTML can only be used in a Node environment\nIf you want to use this in a browser environment, use the `@tiptap/html` import instead.");
	const schema = getSchema(extensions);
	return getHTMLFromFragment(Node.fromJSON(schema, doc), schema);
}
//#endregion
//#region src/server/generateJSON.ts
/**
* Generates a JSON object from the given HTML string and converts it into a Prosemirror node with content.
* @remarks **Important**: This function requires `happy-dom` to be installed in your project.
* @param {string} html - The HTML string to be converted into a Prosemirror node.
* @param {Extensions} extensions - The extensions to be used for generating the schema.
* @param {ParseOptions} options - The options to be supplied to the parser.
* @returns {Promise<Record<string, any>>} - A promise with the generated JSON object.
* @example
* const html = '<p>Hello, world!</p>'
* const extensions = [...]
* const json = generateJSON(html, extensions)
* console.log(json) // { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello, world!' }] }] }
*/
function generateJSON(html, extensions, options) {
	if (!(typeof process !== "undefined" && process.versions != null && process.versions.node != null)) throw new Error("generateJSON can only be used in a Node environment\nIf you want to use this in a browser environment, use the `@tiptap/html` import instead.");
	const localWindow = new Window({ settings: {
		disableJavaScriptEvaluation: true,
		disableJavaScriptFileLoading: true,
		disableCSSFileLoading: true,
		disableIframePageLoading: true,
		disableComputedStyleRendering: true
	} });
	const localDOMParser = new localWindow.DOMParser();
	let result;
	try {
		const schema = getSchema(extensions);
		let doc = null;
		const htmlString = `<!DOCTYPE html><html><body>${html}</body></html>`;
		doc = localDOMParser.parseFromString(htmlString, "text/html");
		if (!doc) throw new Error("Failed to parse HTML string");
		result = DOMParser.fromSchema(schema).parse(doc.body, options).toJSON();
	} finally {
		localWindow.happyDOM.abort();
		localWindow.happyDOM.close();
	}
	return result;
}
//#endregion
export { generateHTML, generateJSON };

//# sourceMappingURL=index.js.map