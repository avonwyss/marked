/**
 * marked - a markdown parser
 * Copyright (c) 2011-2014, Christopher Jeffrey. (MIT Licensed)
 * https://github.com/chjj/marked
 */

/**
	* Helpers
	*/

function escape(html: string, encode?: boolean): string {
	return html
		.replace(!encode ? /&(?!#?\w+;)/g : /&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function unescape(html: string): string {
	// explicitly match decimal, hex, and named HTML entities 
	return html.replace(/&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/g, (_, n) => {
		n = n.toLowerCase();
		if (n === "colon") {
			return ":";
		}
		if (n.charAt(0) === "#") {
			return n.charAt(1) === "x"
				? String.fromCharCode(parseInt(n.substring(2), 16))
				: String.fromCharCode(+n.substring(1));
		}
		return "";
	});
}

type RegExpReplacer = {
		(): RegExp;
		(name: RegExp | string, val: RegExp | string): RegExpReplacer;
	}

function replace(regex: RegExp, opt?: string): RegExpReplacer {
	let pattern = regex.source;
	const self = ((name?: RegExp | string, val?: RegExp | string): RegExp | RegExpReplacer => {
		if (!name) {
			return new RegExp(pattern, opt || "");
		}
		if (val instanceof RegExp) {
			val = val.source;
		}
		val = val.replace(/(^|[^\[])\^/g, "$1");
		pattern = pattern.replace(name as any, val);
		return self;
	}) as RegExpReplacer;
	return self;
}

const noop = new RegExp("^(?=x)$");
noop.exec = (): RegExpExecArray => null;

/**
	* Block-Level Grammar
	*/

type BlockRules = {
		newline: RegExp;
		code: RegExp;
		fences: RegExp;
		hr: RegExp;
		heading: RegExp;
		nptable: RegExp;
		lheading: RegExp;
		blockquote: RegExp;
		list: RegExp;
		html: RegExp;
		def: RegExp;
		table: RegExp;
		paragraph: RegExp;
		text: RegExp;
		bullet: RegExp;
		item: RegExp;
	}

const block: BlockRules & { normal?: BlockRules; gfm?: BlockRules; tables?: BlockRules; } = {
		newline: /^\n+/,
		code: /^( {4}[^\n]+\n*)+/,
		fences: noop,
		hr: /^( *[-*_]){3,} *(?:\n+|$)/,
		heading: /^ *(#{1,6}) *([^\n]+?) *#* *(?:\n+|$)/,
		nptable: noop,
		lheading: /^([^\n]+)\n *(=|-){2,} *(?:\n+|$)/,
		blockquote: /^( *>[^\n]+(\n(?!def)[^\n]+)*\n*)+/,
		list: /^( *)(bull) [\s\S]+?(?:hr|def|\n{2,}(?! )(?!\1bull )\n*|\s*$)/,
		html: /^ *(?:comment *(?:\n|\s*$)|closed *(?:\n{2,}|\s*$)|closing *(?:\n{2,}|\s*$))/,
		def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +["(]([^\n]+)[")])? *(?:\n+|$)/,
		table: noop,
		paragraph: /^((?:[^\n]+\n?(?!hr|heading|lheading|blockquote|tag|def))+)\n*/,
		text: /^[^\n]+/,
		bullet: /(?:[*+-]|\d+\.)/,
		item: /^( *)(bull) [^\n]*(?:\n(?!\1bull )[^\n]*)*/,
	};

const _tag = "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:/|[^\\w\\s@]*@)\\b";

block.item = replace(block.item, "gm")
	(/bull/g, block.bullet)
	();

block.list = replace(block.list)
	(/bull/g, block.bullet)
	("hr", "\\n+(?=\\1?(?:[-*_] *){3,}(?:\\n+|$))")
	("def", "\\n+(?=" + block.def.source + ")")
	();

block.blockquote = replace(block.blockquote)
	("def", block.def)
	();

block.html = replace(block.html)
	("comment", /<!--[\s\S]*?-->/)
	("closed", /<(tag)[\s\S]+?<\/\1>/)
	("closing", /<tag(?:"[^"]*"|'[^']*'|[^'">])*?>/)
	(/tag/g, _tag)
	();

block.paragraph = replace(block.paragraph)
	("hr", block.hr)
	("heading", block.heading)
	("lheading", block.lheading)
	("blockquote", block.blockquote)
	("tag", "<" + _tag)
	("def", block.def)
	();

/**
	* Normal Block Grammar
	*/

block.normal = Object.assign({}, block);

/**
	* GFM Block Grammar
	*/

block.gfm = Object.assign({}, block.normal, {
		fences: /^ *(`{3,}|~{3,})[ \.]*(\S+)? *\n([\s\S]*?)\s*\1 *(?:\n+|$)/,
		paragraph: /^/,
		heading: /^ *(#{1,6}) +([^\n]+?) *#* *(?:\n+|$)/
	});

block.gfm.paragraph = replace(block.paragraph)
	("(?!", "(?!" + block.gfm.fences.source.replace("\\1", "\\2") + "|" + block.list.source.replace("\\1", "\\3") + "|")
	();

/**
	* GFM + Tables Block Grammar
	*/

block.tables = Object.assign({}, block.gfm, {
		nptable: /^ *(\S.*\|.*)\n *([-:]+ *\|[-| :]*)\n((?:.*\|.*(?:\n|$))*)\n*/,
		table: /^ *\|(.+)\n *\|( *[-:]+[-| :]*)\n((?: *\|.*(?:\n|$))*)\n*/
	});

/**
	* Block Lexer
	*/
type Token = {
		type: string;
		text?: string;
		lang?: string;
		depth?: number;
		ordered?: boolean;
		pre?: boolean;
		escaped?: boolean; // Is this really used?
		header?: string[];
		align?: TextAlignment[];
		cells?: string[][];
	}

type TextAlignment = "left" | "center" | "right" | "justify";

type TableCellFlags = {
		header: boolean;
		align?: TextAlignment;
	}

type Link = {
		href: string;
		title: string;
	}

type LinkMap = { [key: string]: Link; };

type TokenArray = Token[] & { links: LinkMap };

type Sanitizer = (html: string) => string;

type Highlighter = (code: string, lang: string, callback?: MarkedCallback) => string;

type MarkedOptions = {
		gfm?: boolean;
		tables?: boolean;
		pedantic?: boolean;
		smartLists?: boolean;
		smartypants?: boolean;
		breaks?: boolean;
		mangle?: boolean;
		sanitize?: boolean;
		langPrefix?: string;
		headerPrefix?: string;
		xhtml?: boolean;
		silent?: boolean;
		sanitizer?: Sanitizer;
		renderer?: Renderer;
		highlight?: Highlighter;
	};

class Lexer {
	/**
		* Expose Block Rules
		*/
	static readonly rules = block;

	/**
		* Static Lex Method
		*/
	static lex(src: string, options?: MarkedOptions) {
		const lexer = new Lexer(options);
		return lexer.lex(src);
	}

	readonly tokens: TokenArray;
	readonly options: MarkedOptions;
	readonly rules: BlockRules;

	constructor(options?: MarkedOptions) {
		this.tokens = [] as TokenArray;
		this.tokens.links = {};
		this.options = options || marked.defaults;
		if (this.options.gfm) {
			if (this.options.tables) {
				this.rules = block.tables;
			} else {
				this.rules = block.gfm;
			}
		} else {
			this.rules = block.normal;
		}
	}

	/**
		* Preprocessing
		*/
	lex(src: string) {
		src = src
			.replace(/\r\n|\r/g, "\n")
			.replace(/\t/g, "    ")
			.replace(/\u00a0/g, " ")
			.replace(/\u2424/g, "\n");

		return this.token(src, true);
	}

	/**
		* Lexing
		*/
	token(src: string, top: boolean, bq?: boolean) {
		src = src.replace(/^ +$/gm, "");

		while (src) {
			let cap: RegExpExecArray;
			// newline
			if (cap = this.rules.newline.exec(src)) {
				src = src.substring(cap[0].length);
				if (cap[0].length > 1) {
					this.tokens.push({
							type: "space"
						});
				}
			}

			// code
			if (cap = this.rules.code.exec(src)) {
				src = src.substring(cap[0].length);
				const text = cap[0].replace(/^ {4}/gm, "");
				this.tokens.push({
						type: "code",
						text: !this.options.pedantic
							? text.replace(/\n+$/, "")
							: text
					});
				continue;
			}

			// fences (gfm)
			if (cap = this.rules.fences.exec(src)) {
				src = src.substring(cap[0].length);
				this.tokens.push({
						type: "code",
						lang: cap[2],
						text: cap[3] || ""
					});
				continue;
			}

			// heading
			if (cap = this.rules.heading.exec(src)) {
				src = src.substring(cap[0].length);
				this.tokens.push({
						type: "heading",
						depth: cap[1].length,
						text: cap[2]
					});
				continue;
			}

			// table no leading pipe (gfm)
			if (top && (cap = this.rules.nptable.exec(src))) {
				src = src.substring(cap[0].length);

				const item: Token = {
						type: "table",
						header: cap[1].replace(/^ *| *\| *$/g, "").split(/ *\| */),
						align: cap[2].replace(/^ *|\| *$/g, "").split(/ *\| */) as TextAlignment[],
						cells: []
					};

				for (let i = 0; i < item.align.length; i++) {
					if (/^ *-+: *$/.test(item.align[i])) {
						item.align[i] = "right";
					} else if (/^ *:-+: *$/.test(item.align[i])) {
						item.align[i] = "center";
					} else if (/^ *:-+ *$/.test(item.align[i])) {
						item.align[i] = "left";
					} else {
						item.align[i] = null;
					}
				}

				const cells = cap[3].replace(/\n$/, "").split("\n");
				for (let i = 0; i < cells.length; i++) {
					item.cells[i] = cells[i].split(/ *\| */);
				}

				this.tokens.push(item);

				continue;
			}

			// lheading
			if (cap = this.rules.lheading.exec(src)) {
				src = src.substring(cap[0].length);
				this.tokens.push({
						type: "heading",
						depth: cap[2] === "=" ? 1 : 2,
						text: cap[1]
					});
				continue;
			}

			// hr
			if (cap = this.rules.hr.exec(src)) {
				src = src.substring(cap[0].length);
				this.tokens.push({
						type: "hr"
					});
				continue;
			}

			// blockquote
			if (cap = this.rules.blockquote.exec(src)) {
				src = src.substring(cap[0].length);

				this.tokens.push({
						type: "blockquote_start"
					});

				const text = cap[0].replace(/^ *> ?/gm, "");

				// Pass `top` to keep the current
				// "toplevel" state. This is exactly
				// how markdown.pl works.
				this.token(text, top, true);

				this.tokens.push({
						type: "blockquote_end"
					});

				continue;
			}

			// list
			if (cap = this.rules.list.exec(src)) {
				src = src.substring(cap[0].length);
				const bull = cap[2];

				this.tokens.push({
						type: "list_start",
						ordered: bull.length > 1
					});

				// Get each top-level item.
				const items = cap[0].match(this.rules.item);

				let next = false;
				const l = items.length;

				for (let i = 0; i < l; i++) {
					let item = items[i];

					// Remove the list item's bullet
					// so it is seen as the next token.
					let space = item.length;
					item = item.replace(/^ *([*+-]|\d+\.) +/, "");

					// Outdent whatever the
					// list item contains. Hacky.
					if (item.indexOf("\n ") < 0) {
						space -= item.length;
						item = !this.options.pedantic
							? item.replace(new RegExp("^ {1," + space + "}", "gm"), "")
							: item.replace(/^ {1,4}/gm, "");
					}

					// Determine whether the next list item belongs here.
					// Backpedal if it does not belong in this list.
					if (this.options.smartLists && i !== l - 1) {
						const b = block.bullet.exec(items[i + 1])[0];
						if (bull !== b && !(bull.length > 1 && b.length > 1)) {
							src = items.slice(i + 1).join("\n") + src;
							i = l - 1;
						}
					}

					// Determine whether item is loose or not.
					// Use: /(^|\n)(?! )[^\n]+\n\n(?!\s*$)/
					// for discount behavior.
					let loose = next || /\n\n(?!\s*$)/.test(item);
					if (i !== l - 1) {
						next = item.charAt(item.length - 1) === "\n";
						if (!loose) {
							loose = next;
						}
					}

					this.tokens.push({
							type: loose
								? "loose_item_start"
								: "list_item_start"
						});

					// Recurse.
					this.token(item, false, bq);

					this.tokens.push({
							type: "list_item_end"
						});
				}

				this.tokens.push({
						type: "list_end"
					});

				continue;
			}

			// html
			if (cap = this.rules.html.exec(src)) {
				src = src.substring(cap[0].length);
				this.tokens.push({
						type: this.options.sanitize
							? "paragraph"
							: "html",
						pre: !this.options.sanitizer && (cap[1] === "pre" || cap[1] === "script" || cap[1] === "style"),
						text: cap[0]
					});
				continue;
			}

			// def
			if ((!bq && top) && (cap = this.rules.def.exec(src))) {
				src = src.substring(cap[0].length);
				this.tokens.links[cap[1].toLowerCase()] = {
						href: cap[2],
						title: cap[3]
					};
				continue;
			}

			// table (gfm)
			if (top && (cap = this.rules.table.exec(src))) {
				src = src.substring(cap[0].length);

				const item: Token = {
						type: "table",
						header: cap[1].replace(/^ *| *\| *$/g, "").split(/ *\| */),
						align: cap[2].replace(/^ *|\| *$/g, "").split(/ *\| */) as TextAlignment[],
						cells: []
					};

				for (let i = 0; i < item.align.length; i++) {
					if (/^ *-+: *$/.test(item.align[i])) {
						item.align[i] = "right";
					} else if (/^ *:-+: *$/.test(item.align[i])) {
						item.align[i] = "center";
					} else if (/^ *:-+ *$/.test(item.align[i])) {
						item.align[i] = "left";
					} else {
						item.align[i] = null;
					}
				}

				const cells = cap[3].replace(/(?: *\| *)?\n$/, "").split("\n");
				for (let i = 0; i < cells.length; i++) {
					item.cells[i] = cells[i]
						.replace(/^ *\| *| *\| *$/g, "")
						.split(/ *\| */);
				}

				this.tokens.push(item);

				continue;
			}

			// top-level paragraph
			if (top && (cap = this.rules.paragraph.exec(src))) {
				src = src.substring(cap[0].length);
				this.tokens.push({
						type: "paragraph",
						text: cap[1].charAt(cap[1].length - 1) === "\n"
							? cap[1].slice(0, -1)
							: cap[1]
					});
				continue;
			}

			// text
			if (cap = this.rules.text.exec(src)) {
				// Top-level should never reach here.
				src = src.substring(cap[0].length);
				this.tokens.push({
						type: "text",
						text: cap[0]
					});
				continue;
			}

			if (src) {
				throw new
					Error("Infinite loop on byte: " + src.charCodeAt(0));
			}
		}

		return this.tokens;
	}
}

/**
	* Inline-Level Grammar
	*/

type InlineRules = {
		escape: RegExp;
		autolink: RegExp;
		url: RegExp;
		tag: RegExp;
		link: RegExp;
		reflink: RegExp;
		nolink: RegExp;
		strong: RegExp;
		em: RegExp;
		code: RegExp;
		br: RegExp;
		del: RegExp;
		text: RegExp;
	}

var inline: InlineRules & { normal?: InlineRules; pedantic?: InlineRules; gfm?: InlineRules; breaks?: InlineRules; } = {
		escape: /^\\([\\`*{}\[\]()#+\-.!_>])/,
		autolink: /^<([^ >]+(@|:\/)[^ >]+)>/,
		url: noop,
		tag: /^<!--[\s\S]*?-->|^<\/?\w+(?:"[^"]*"|'[^']*'|[^'">])*?>/,
		link: /^!?\[(inside)\]\(href\)/,
		reflink: /^!?\[(inside)\]\s*\[([^\]]*)\]/,
		nolink: /^!?\[((?:\[[^\]]*\]|[^\[\]])*)\]/,
		strong: /^__([\s\S]+?)__(?!_)|^\*\*([\s\S]+?)\*\*(?!\*)/,
		em: /^\b_((?:[^_]|__)+?)_\b|^\*((?:\*\*|[\s\S])+?)\*(?!\*)/,
		code: /^(`+)\s*([\s\S]*?[^`])\s*\1(?!`)/,
		br: /^ {2,}\n(?!\s*$)/,
		del: noop,
		text: /^[\s\S]+?(?=[\\<!\[_*`]| {2,}\n|$)/,
	};

const _inside= /(?:\[[^\]]*\]|[^\[\]]|\](?=[^\[]*\]))*/;
const _href = /\s*<?([\s\S]*?)>?(?:\s+['"]([\s\S]*?)['"])?\s*/;

	inline.link = replace(inline.link)
	("inside", _inside)
	("href", _href)
	();

inline.reflink = replace(inline.reflink)
	("inside", _inside)
	();

/**
	* Normal Inline Grammar
	*/

inline.normal = Object.assign({}, inline);

/**
	* Pedantic Inline Grammar
	*/

inline.pedantic = Object.assign({}, inline.normal, {
		strong: /^__(?=\S)([\s\S]*?\S)__(?!_)|^\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/,
		em: /^_(?=\S)([\s\S]*?\S)_(?!_)|^\*(?=\S)([\s\S]*?\S)\*(?!\*)/
	});

/**
	* GFM Inline Grammar
	*/

inline.gfm = Object.assign({}, inline.normal, {
		escape: replace(inline.escape)("])", "~|])")(),
		url: /^(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/,
		del: /^~~(?=\S)([\s\S]*?\S)~~/,
		text: replace(inline.text)
			("]|", "~]|")
			("|", "|https?://|")
			()
	});

/**
	* GFM + Line Breaks Inline Grammar
	*/

inline.breaks = Object.assign({}, inline.gfm, {
		br: replace(inline.br)("{2,}", "*")(),
		text: replace(inline.gfm.text)("{2,}", "*")()
	});

/**
	* Inline Lexer & Compiler
	*/
class InlineLexer {
	/**
		* Expose Inline Rules
		*/
	static readonly rules = inline;

	/**
		* Static Lexing/Compiling Method
		*/
	static output(src: string, links: LinkMap, options?: MarkedOptions) {
		const inline = new InlineLexer(links, options);
		return inline.output(src);
	};

	readonly options: MarkedOptions;
	readonly rules: InlineRules;
	readonly links: LinkMap;
	readonly renderer: Renderer;
	inLink: boolean;

	constructor(links: LinkMap, options?: MarkedOptions, renderer?: Renderer) {
		this.options = options || marked.defaults;
		this.links = links;
		this.renderer = renderer || this.options.renderer || new Renderer();
		this.renderer.options = this.options;

		if (!this.links) {
			throw new
				Error("Tokens array requires a `links` property.");
		}

		if (this.options.gfm) {
			if (this.options.breaks) {
				this.rules = inline.breaks;
			} else {
				this.rules = inline.gfm;
			}
		} else if (this.options.pedantic) {
			this.rules = inline.pedantic;
		} else {
			this.rules = inline.normal;
		}
	}

	/**
		* Lexing/Compiling
		*/
	output(src: string) {
		let out = "";
		while (src) {
			let cap: RegExpExecArray;
			// escape
			if (cap = this.rules.escape.exec(src)) {
				src = src.substring(cap[0].length);
				out += cap[1];
				continue;
			}

			// autolink
			if (cap = this.rules.autolink.exec(src)) {
				let text: string;
				let href: string;
				src = src.substring(cap[0].length);
				if (cap[2] === "@") {
					text = cap[1].charAt(6) === ":"
						? this.mangle(cap[1].substring(7))
						: this.mangle(cap[1]);
					href = this.mangle("mailto:") + text;
				} else {
					text = escape(cap[1]);
					href = text;
				}
				out += this.renderer.link(href, null, text);
				continue;
			}

			// url (gfm)
			if (!this.inLink && (cap = this.rules.url.exec(src))) {
				src = src.substring(cap[0].length);
				const text = escape(cap[1]);
				const href = text;
				out += this.renderer.link(href, null, text);
				continue;
			}

			// tag
			if (cap = this.rules.tag.exec(src)) {
				if (!this.inLink && /^<a /i.test(cap[0])) {
					this.inLink = true;
				} else if (this.inLink && /^<\/a>/i.test(cap[0])) {
					this.inLink = false;
				}
				src = src.substring(cap[0].length);
				out += this.options.sanitize
					? this.options.sanitizer
					? this.options.sanitizer(cap[0])
					: escape(cap[0])
					: cap[0];
				continue;
			}

			// link
			if (cap = this.rules.link.exec(src)) {
				src = src.substring(cap[0].length);
				this.inLink = true;
				out += this.outputLink(cap, {
						href: cap[2],
						title: cap[3]
					});
				this.inLink = false;
				continue;
			}

			// reflink, nolink
			if ((cap = this.rules.reflink.exec(src)) || (cap = this.rules.nolink.exec(src))) {
				src = src.substring(cap[0].length);
				const linkKey = (cap[2] || cap[1]).replace(/\s+/g, " ");
				const link = this.links[linkKey.toLowerCase()];
				if (!link || !link.href) {
					out += cap[0].charAt(0);
					src = cap[0].substring(1) + src;
					continue;
				}
				this.inLink = true;
				out += this.outputLink(cap, link);
				this.inLink = false;
				continue;
			}

			// strong
			if (cap = this.rules.strong.exec(src)) {
				src = src.substring(cap[0].length);
				out += this.renderer.strong(this.output(cap[2] || cap[1]));
				continue;
			}

			// em
			if (cap = this.rules.em.exec(src)) {
				src = src.substring(cap[0].length);
				out += this.renderer.em(this.output(cap[2] || cap[1]));
				continue;
			}

			// code
			if (cap = this.rules.code.exec(src)) {
				src = src.substring(cap[0].length);
				out += this.renderer.codespan(escape(cap[2], true));
				continue;
			}

			// br
			if (cap = this.rules.br.exec(src)) {
				src = src.substring(cap[0].length);
				out += this.renderer.br();
				continue;
			}

			// del (gfm)
			if (cap = this.rules.del.exec(src)) {
				src = src.substring(cap[0].length);
				out += this.renderer.del(this.output(cap[1]));
				continue;
			}

			// text
			if (cap = this.rules.text.exec(src)) {
				src = src.substring(cap[0].length);
				out += this.renderer.text(escape(this.smartypants(cap[0])));
				continue;
			}

			if (src) {
				throw new
					Error("Infinite loop on byte: " + src.charCodeAt(0));
			}
		}

		return out;
	}

	/**
		* Compile Link
		*/
	private outputLink(cap: RegExpExecArray, link: Link): string {
		const href = escape(link.href);
		const title = link.title ? escape(link.title) : null;

		return cap[0].charAt(0) !== "!"
			? this.renderer.link(href, title, this.output(cap[1]))
			: this.renderer.image(href, title, escape(cap[1]));
	}

	/**
		* Smartypants Transformations
		*/
	smartypants(text: string): string {
		if (!this.options.smartypants) {
			return text;
		}
		return text
			// em-dashes
			.replace(/---/g, "\u2014")
			// en-dashes
			.replace(/--/g, "\u2013")
			// opening singles
			.replace(/(^|[-\u2014/(\[{"\s])'/g, "$1\u2018")
			// closing singles & apostrophes
			.replace(/'/g, "\u2019")
			// opening doubles
			.replace(/(^|[-\u2014/(\[{\u2018\s])"/g, "$1\u201c")
			// closing doubles
			.replace(/"/g, "\u201d")
			// ellipses
			.replace(/\.{3}/g, "\u2026");
	}

	/**
		* Mangle Links
		*/
	mangle(text: string): string {
		if (!this.options.mangle) {
			return text;
		}
		let out = "";
		const l = text.length;
		for (let i = 0; i < l; i++) {
			const ch = text.charCodeAt(i);
			if (Math.random() > 0.5) {
				out += `&#x${ch.toString(16)};`;
			} else {
				out += `&#${ch};`;
			}
		}
		return out;
	};
}

/**
	* Renderer
	*/
class Renderer {
	options: MarkedOptions;

	constructor(options?: MarkedOptions) {
		this.options = options || {};
		if (this.options.langPrefix == null) {
			this.options.langPrefix = "";
		}
		if (this.options.headerPrefix == null) {
			this.options.headerPrefix = "";
		}
	}

	code(code: string, lang: string, escaped: boolean): string {
		if (this.options.highlight) {
			const out = this.options.highlight(code, lang);
			if (out != null) { // AvW: removed  "&& out !== code"
				escaped = true;
				code = out;
			}
		}

		if (!lang) {
			return `<pre><code>${escaped ? code : escape(code, true)}\n</code></pre>`;
		}

		return `<pre><code class="${this.options.langPrefix}${escape(lang, true)}">${escaped ? code : escape(code, true)}\n</code></pre>\n`;
	}

	blockquote(quote: string) {
		return `<blockquote>\n${quote}</blockquote>\n`;
	}

	html(html: string) {
		return html;
	}

	heading(text: string, level: number, raw: string) {
		return `<h${level} id="${this.options.headerPrefix}${raw.toLowerCase().replace(/[^\w]+/g, "-")}">${text}</h${level}>\n`;
	}

	hr() {
		return this.options.xhtml ? "<hr/>\n" : "<hr>\n";
	}

	list(body: string, ordered: boolean) {
		const type = ordered ? "ol" : "ul";
		return `<${type}>\n${body}</${type}>\n`;
	}

	listitem(text: string) {
		return `<li>${text}</li>\n`;
	}

	paragraph(text: string) {
		return `<p>${text}</p>\n`;
	}

	table(header: string, body: string) {
		return `<table>\n<thead>\n${header}</thead>\n<tbody>\n${body}</tbody>\n</table>\n`;
	}

	tablerow(content: string) {
		return `<tr>\n${content}</tr>\n`;
	}

	tablecell(content: string, flags: TableCellFlags) {
		const type = flags.header ? "th" : "td";
		const tag = flags.align
			? `<${type} style="text-align:${flags.align}">`
			: `<${type}>`;
		return `${tag}${content}</${type}>\n`;
	}

	// span level renderer
	strong(text: string) {
		return `<strong>${text}</strong>`;
	}

	em(text: string) {
		return `<em>${text}</em>`;
	}

	codespan(text: string) {
		return `<code>${text}</code>`;
	}

	br() {
		return this.options.xhtml ? "<br/>" : "<br>";
	}

	del(text: string) {
		return `<del>${text}</del>`;
	}

	link(href: string, title: string, text: string) {
		if (this.options.sanitize) {
			let prot: string;
			try {
				prot = decodeURIComponent(unescape(href))
					.replace(/[^\w:]/g, "")
					.toLowerCase();
			} catch (e) {
				return "";
			}
			if (prot.indexOf("javascript:") === 0 || prot.indexOf("vbscript:") === 0 || prot.indexOf("data:") === 0) {
				return "";
			}
		}
		let out = `<a href="${href}"`;
		if (title) {
			out += ` title="${title}"`;
		}
		out += `>${text}</a>`;
		return out;
	}

	image(href: string, title: string, text: string) {
		if (this.options.sanitize) {
			let prot: string;
			try {
				prot = decodeURIComponent(unescape(href))
					.replace(/[^\w:]/g, "")
					.toLowerCase();
			} catch (e) {
				return "";
			}
			if (prot.indexOf("javascript:") === 0 || prot.indexOf("vbscript:") === 0) {
				return "";
			}
		}
		let out = `<img src="${href}" alt="${text}"`;
		if (title) {
			out += ` title="${title}"`;
		}
		out += this.options.xhtml ? "/>" : ">";
		return out;
	}

	text(text: string) {
		return text;
	};
}

/**
	* Parsing & Compiling
	*/
class Parser {
	/**
		* Static Parse Method
		*/
	static parse(src: TokenArray, options?: MarkedOptions, renderer?: Renderer) {
		const parser = new Parser(options, renderer);
		return parser.parse(src);
	};

	readonly options: MarkedOptions;
	readonly renderer: Renderer;
	tokens: Token[];
	inline: InlineLexer;
	token: Token;

	constructor(options?: MarkedOptions, renderer?: Renderer) {
		this.tokens = [];
		this.token = null;
		this.options = options || marked.defaults;
		this.options.renderer = renderer || this.options.renderer || new Renderer();
		this.renderer = this.options.renderer;
		this.renderer.options = this.options;
	}

	/**
		* Parse Loop
		*/
	parse(src: TokenArray) {
		this.inline = new InlineLexer(src.links, this.options, this.renderer);
		this.tokens = src.reverse();

		let out = "";
		while (this.next()) {
			out += this.tok();
		}

		return out;
	};

	/**
		* Next Token
		*/
	next() {
		return this.token = this.tokens.pop();
	};

	/**
		* Preview Next Token
		*/
	peek() {
		return this.tokens[this.tokens.length - 1] || { type: null };
	};

	/**
		* Parse Text Tokens
		*/
	parseText() {
		let body = this.token.text;
		while (this.peek().type === "text") {
			body += "\n" + this.next().text;
		}
		return this.inline.output(body);
	};

	/**
		* Parse Current Token
		*/
	tok() {
		const tokenType = this.token.type;
		switch (tokenType) {
		case "space":
		{
			return "";
		}
		case "hr":
		{
			return this.renderer.hr();
		}
		case "heading":
		{
			return this.renderer.heading(
				this.inline.output(this.token.text),
				this.token.depth,
				this.token.text);
		}
		case "code":
		{
			return this.renderer.code(this.token.text,
				this.token.lang,
				this.token.escaped);
		}
		case "table":
		{
			let header = "";
			let body = "";

			// header
			let cell = "";
			for (let i = 0; i < this.token.header.length; i++) {
				cell += this.renderer.tablecell(
						this.inline.output(this.token.header[i]),
						{ header: true, align: this.token.align[i] }
					);
			}
			header += this.renderer.tablerow(cell);

			for (let i = 0; i < this.token.cells.length; i++) {
				const row = this.token.cells[i];

				cell = "";
				for (let j = 0; j < row.length; j++) {
					cell += this.renderer.tablecell(
							this.inline.output(row[j]),
							{ header: false, align: this.token.align[j] }
						);
				}

				body += this.renderer.tablerow(cell);
			}
			return this.renderer.table(header, body);
		}
		case "blockquote_start":
		{
			let body = "";

			while (this.next().type !== "blockquote_end") {
				body += this.tok();
			}

			return this.renderer.blockquote(body);
		}
		case "list_start":
		{
			let body = "", ordered = this.token.ordered;

			while (this.next().type !== "list_end") {
				body += this.tok();
			}

			return this.renderer.list(body, ordered);
		}
		case "list_item_start":
		{
			let body = "";

			while (this.next().type !== "list_item_end") {
				body += this.token.type === "text"
					? this.parseText()
					: this.tok();
			}

			return this.renderer.listitem(body);
		}
		case "loose_item_start":
		{
			let body = "";

			while (this.next().type !== "list_item_end") {
				body += this.tok();
			}

			return this.renderer.listitem(body);
		}
		case "html":
		{
			let html = !this.token.pre && !this.options.pedantic
				? this.inline.output(this.token.text)
				: this.token.text;
			return this.renderer.html(html);
		}
		case "paragraph":
		{
			return this.renderer.paragraph(this.inline.output(this.token.text));
		}
		case "text":
		{
			return this.renderer.paragraph(this.parseText());
		}
		}
		throw new Error("Unknown token type " + tokenType);
	}
}

/**
	* Marked
	*/
type MarkedCallback = (error: any, result?: string) => string;

type Marked = {
		(src: string, callback?: MarkedCallback): string;
		(src: string, options: MarkedOptions, callback?: MarkedCallback): string;
		defaults: MarkedOptions;
		setOptions(options: MarkedOptions): Marked;
		Parser: typeof Parser;
		parser: typeof Parser.parse;
		Renderer: typeof Renderer;
		Lexer: typeof Lexer;
		lexer: typeof Lexer.lex;
		InlineLexer: typeof InlineLexer;
		inlineLexer: typeof InlineLexer.output;
	}

const marked: Marked = ((src: string, options?: MarkedOptions | MarkedCallback, callback?: MarkedCallback): string => {
	const opt: MarkedOptions = options = Object.assign({}, marked.defaults);
	if (options) {
		if (typeof options === "function") {
			callback = options as MarkedCallback;
		} else {
			Object.assign(opt, options);
		}
	}
	if (callback) {
		const highlight = opt.highlight;
		let tokens: TokenArray;

		try {
			tokens = Lexer.lex(src, opt);
		} catch (e) {
			return callback(e);
		}

		let pending = tokens.length;

		const done = (err?: any): string => {
			let out: string = undefined;
			if (!err) {
				try {
					out = Parser.parse(tokens, opt);
				} catch (e) {
					err = e;
				}
			}
			opt.highlight = highlight;
			return callback(err || null, out);
		};

		if (!highlight || highlight.length < 3) {
			return done();
		}

		delete opt.highlight;

		if (!pending) {
			return done();
		}

		const decPendingAndDone = () => {
			--pending;
			if (!pending) {
				return done();
			}
			return null;
		};
		for (let i = 0; i < tokens.length; i++) {
			(token => {
				if (token.type !== "code") {
					return decPendingAndDone();
				}
				return highlight(token.text, token.lang, (err, code) => {
					if (err) {
						return done(err);
					}
					if (code == null || code === token.text) {
						return decPendingAndDone();
					}
					token.text = code;
					token.escaped = true;
					return decPendingAndDone();
				});
			})(tokens[i]);
		}

		return null;
	}
	try {
		return Parser.parse(Lexer.lex(src, opt), opt);
	} catch (e) {
		e.message += "\nPlease report this to https://github.com/chjj/marked.";
		if ((opt || marked.defaults).silent) {
			return "<p>An error occured:</p><pre>" + escape(e.message + "", true) + "</pre>";
		}
		throw e;
	}
}) as any;

/**
	* Options
	*/

marked.setOptions = opt => {
	Object.assign(marked.defaults, opt);
	return marked;
};

marked.defaults = {
		gfm: true,
		tables: true,
		breaks: false,
		pedantic: false,
		sanitize: false,
		sanitizer: null,
		mangle: true,
		smartLists: false,
		silent: false,
		highlight: null,
		langPrefix: "lang-",
		smartypants: false,
		headerPrefix: "",
		renderer: new Renderer(),
		xhtml: false
	};

/**
	* Expose
	*/

marked.Parser = Parser;
marked.parser = Parser.parse;

marked.Renderer = Renderer;

marked.Lexer = Lexer;
marked.lexer = Lexer.lex;

marked.InlineLexer = InlineLexer;
marked.inlineLexer = InlineLexer.output;

export = marked;