import { HTMLElement, parse } from 'node-html-parser';
import { ClassDoc, MemberDetail, MemberKind, MemberSummary, TypeKind } from '../types.js';

export interface RawClassPage {
  title: string;
  declaration: string;
  description: string;
  deprecated: boolean;
  since?: string;
  superClass?: string;
  interfaces: string[];
  /** Kind inferred from the page title / declaration. */
  kind: TypeKind;
  members: MemberDetail[];
  legacy: boolean;
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Extract visible text of an element. */
const text = (el: HTMLElement | null | undefined): string => (el ? clean(el.text ?? '') : '');

function nodeText(el: HTMLElement): string {
  return clean(el.text ?? '');
}

function kindFromTitle(title: string, declaration: string): TypeKind {
  if (/^annotation type /i.test(title) || /@interface/.test(declaration)) return 'annotation';
  if (/^interface /i.test(title) || /^(public |protected |private )*interface\b/.test(declaration)) return 'interface';
  if (/^enum /i.test(title) || /\benum\b/.test(declaration)) return 'enum';
  if (/^record /i.test(title) || /\brecord\b/.test(declaration)) return 'record';
  if (/^class /i.test(title) || /\bclass\b/.test(declaration)) return 'class';
  return 'unknown';
}

interface Notes {
  [label: string]: string[];
}

/** Parse a javadoc `<dl class="notes">` element into label -> array of dd texts. */
function parseNotes(dl: HTMLElement | null | undefined): Notes {
  const out: Notes = {};
  if (!dl) return out;
  const dts = dl.querySelectorAll('dt');
  for (const dt of dts) {
    const label = nodeText(dt).replace(/:\s*$/, '');
    if (!label) continue;
    let dd = dt.nextElementSibling;
    const parts: string[] = [];
    while (dd && dd.tagName.toLowerCase() === 'dd') {
      parts.push(nodeText(dd));
      dd = dd.nextElementSibling;
    }
    if (parts.length) out[label] = parts;
  }
  return out;
}

interface NoteItem {
  name: string;
  description: string;
}

/**
 * Parse `Parameters:` / `Throws:` dd texts like `name - description`.
 * Modern javadoc emits one `<dd>` per parameter; legacy javadoc may pack
 * several `name - description` pairs into a single dd.
 */
function parseItems(ddTexts: string[] | undefined): NoteItem[] {
  if (!ddTexts) return [];
  const items: NoteItem[] = [];
  for (const text of ddTexts) {
    const segments = text.split(/\s+(?=[A-Za-z_$][\w$]*\s+-)/);
    for (const seg of segments) {
      const m = seg.match(/^\s*(.+?)\s*-\s*(.*)$/);
      items.push({
        name: m ? m[1].trim() : seg.trim(),
        description: m ? m[2].trim() : '',
      });
    }
  }
  return items.filter((i) => i.name.length > 0);
}

function memberKind(kind: string): MemberKind {
  switch (kind) {
    case 'field':
      return 'field';
    case 'constructor':
      return 'constructor';
    case 'method':
      return 'method';
    case 'enum-constant':
      return 'enum-constant';
    case 'annotation-element':
      return 'annotation-element';
    default:
      return 'unknown';
  }
}

function signatureOf(sigEl: HTMLElement): string {
  const spans = sigEl.querySelectorAll('span');
  const parts: string[] = [];
  for (const span of spans) {
    const cls = span.classNames ?? '';
    const txt = clean(span.text ?? '');
    if (!txt) continue;
    if (cls.split(/\s+/).includes('parameters')) {
      // parameters text already contains parens
      parts.push(txt);
    } else {
      parts.push(txt);
    }
  }
  // Fallback: strip spans and use raw text.
  if (parts.length === 0) return clean(sigEl.text ?? '');
  return parts.join(' ').replace(/\s+\(/g, '(');
}

function elementName(sigEl: HTMLElement): string {
  const nameSpan = sigEl.querySelector('span.element-name, .memberNameLink');
  if (nameSpan) return clean(nameSpan.text ?? '');
  const m = clean(sigEl.text ?? '').match(/\b([A-Za-z_$][\w$]*)\s*\(/);
  return m ? m[1] : '';
}

/** Determine the member kind by climbing to the enclosing details section. */
function memberKindOf(sigEl: HTMLElement): MemberKind {
  let el: HTMLElement | null = sigEl.parentNode as HTMLElement | null;
  while (el) {
    const cls = el.classNames ?? '';
    if (cls.includes('field-details')) return 'field';
    if (cls.includes('constructor-details')) return 'constructor';
    if (cls.includes('enum-constant-details')) return 'enum-constant';
    if (cls.includes('annotation-type-element-details')) return 'annotation-element';
    if (cls.includes('method-details')) return 'method';
    el = el.parentNode as HTMLElement | null;
  }
  return 'method';
}

/** Build a member record from a modern `div.member-signature`. */
function memberFromSignature(
  sigEl: HTMLElement,
  kind: MemberKind,
  url: string,
  index: number,
): MemberDetail {
  const name = elementName(sigEl) || `member-${index}`;
  const signature = signatureOf(sigEl);
  const section = (sigEl.closest('section[data-anchor], section[id]') ?? sigEl.parentNode) as HTMLElement | null;
  const anchor = (section?.getAttribute?.('id') ?? '') || name;

  // Description / notes / deprecation may sit beside the signature (JDK 11+)
  // or outside a wrapping `div.horizontal-scroll` (JDK 17). Query the whole
  // member section so both layouts are covered.
  let description = '';
  let deprecated = '';
  let notes: Notes = {};
  if (section) {
    const block = section.querySelector('div.block');
    description = block ? nodeText(block as HTMLElement) : '';
    const dep = section.querySelector('.deprecation-block');
    deprecated = dep ? nodeText(dep as HTMLElement) : '';
    notes = parseNotes(section.querySelector('dl.notes'));
  } else {
    let cursor = sigEl.nextElementSibling;
    while (cursor && cursor.tagName.toLowerCase() !== 'section') {
      if (cursor.classNames.includes('block')) description = nodeText(cursor);
      else if (cursor.classNames.includes('deprecation-block')) deprecated = nodeText(cursor);
      else if (cursor.tagName.toLowerCase() === 'dl') notes = { ...notes, ...parseNotes(cursor) };
      cursor = cursor.nextElementSibling;
    }
  }

  const params = parseItems(notes['Parameters']);
  return {
    kind,
    name,
    signature,
    anchor,
    description: description || (notes['Description']?.[0] ?? ''),
    fullDescription: description,
    modifiers: signatureOf(sigEl),
    parameters: params.length ? params.map((p) => ({ name: p.name, type: p.name, description: p.description })) : undefined,
    returns: notes['Returns']?.[0],
    throws: notes['Throws'] ? parseItems(notes['Throws']).map((t) => ({ type: t.name, description: t.description })) : undefined,
    since: notes['Since']?.[0],
    deprecated: deprecated || notes['Deprecated']?.[0] || undefined,
    specNote: notes['Specified by']?.[0] || notes['Overrides']?.[0] || undefined,
    url,
  };
}

/** Parse modern HTML5 javadoc (JDK 10+). */
function parseModern(root: HTMLElement, url: string): RawClassPage {
  const titleEl = root.querySelector('h1.title, h2.title, h1');
  const title = text(titleEl);
  const titleMatch = title.match(/^(Class|Interface|Enum|Record|Annotation Type|Exception)\s+(.+)$/i);
  const simpleName = titleMatch ? titleMatch[2] : '';

  const descSection = root.querySelector('section.class-description, div.description');
  const sigEl = descSection?.querySelector('div.type-signature, div.signature, pre') ?? root.querySelector('div.type-signature');
  const declaration = sigEl ? nodeText(sigEl as HTMLElement) : title;

  let description = '';
  let deprecated = false;
  let since: string | undefined;
  const interfaces: string[] = [];
  if (descSection) {
    const block = descSection.querySelector('div.block');
    description = block ? nodeText(block) : '';
    deprecated = descSection.querySelector('.deprecation-block, .deprecated-label, .deprecated-since') !== null;
    const notes = parseNotes(descSection.querySelector('dl.notes'));
    since = notes['Since']?.[0];
    const ifaceList = notes['All Implemented Interfaces'];
    if (ifaceList) {
      for (const name of ifaceList) {
        for (const part of name.split(',')) {
          const trimmed = part.trim();
          if (trimmed) interfaces.push(trimmed);
        }
      }
    }
  }

  // Hierarchy: div.inheritance lists superclasses.
  let superClass: string | undefined;
  const inheritanceEl = root.querySelector('div.inheritance');
  if (inheritanceEl) {
    const links = inheritanceEl.querySelectorAll('a');
    const names = links.map((a) => nodeText(a as HTMLElement)).filter(Boolean);
    if (names.length) superClass = names[names.length - 1];
  }
  if (!superClass) {
    const ext = declaration.match(/\bextends\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/);
    if (ext) superClass = ext[1];
  }
  const impl = declaration.match(/\bimplements\s+(.+)$/);
  if (impl) {
    for (const name of impl[1].split(',')) {
      const trimmed = name.replace(/<.*>/, '').trim();
      if (trimmed) interfaces.push(trimmed);
    }
  }

  const kind = kindFromTitle(title, declaration);

  const members: MemberDetail[] = [];
  const detailsRoot = root.querySelector('section.details, div.details');
  const sigNodes = detailsRoot ? detailsRoot.querySelectorAll('div.member-signature') : [];
  for (let i = 0; i < sigNodes.length; i++) {
    const sig = sigNodes[i] as HTMLElement;
    members.push(memberFromSignature(sig, memberKindOf(sig), url, i));
  }

  return { title, declaration, description, deprecated, since, superClass, interfaces, kind, members, legacy: false };
}

/** Parse legacy table-based javadoc (JDK 8 / HTML4). */
function parseLegacy(root: HTMLElement, url: string): RawClassPage {
  const titleEl = root.querySelector('h2.title, h1.title, h1');
  const title = text(titleEl);
  const titleMatch = title.match(/^(Class|Interface|Enum|Record|Annotation Type|Exception)\s+(.+)$/i);
  const simpleName = titleMatch ? titleMatch[2] : '';

  const descBlock = root.querySelector('div.description');
  const pre = descBlock?.querySelector('pre') ?? root.querySelector('pre');
  const declaration = pre ? nodeText(pre as HTMLElement) : title;

  let description = '';
  let deprecated = false;
  if (descBlock) {
    const block = descBlock.querySelector('div.block');
    description = block ? nodeText(block) : '';
    deprecated = descBlock.querySelector('.deprecated, .deprecatedLabel') !== null;
  }

  const kind = kindFromTitle(title, declaration);
  const superClassMatch = declaration.match(/\bextends\s+([^\s<,]+)/);
  const implMatch = declaration.match(/\bimplements\s+(.+)$/);
  const interfaces: string[] = [];
  if (implMatch) {
    for (const name of implMatch[1].split(',')) {
      const trimmed = name.trim();
      if (trimmed) interfaces.push(trimmed);
    }
  }

  const members: MemberDetail[] = [];
  const detailsRoot = root.querySelector('div.details');
  if (detailsRoot) {
    const lis = detailsRoot.querySelectorAll('li.blockList');
    for (let i = 0; i < lis.length; i++) {
      const li = lis[i] as HTMLElement;
      const sigPre = li.querySelector('pre');
      if (!sigPre) continue;
      const signature = clean(sigPre.text ?? '');
      const nameLink = li.querySelector('a[name], h4');
      const name = nameLink ? clean(nameLink.text ?? '') : '';
      const anchor = (li.querySelector('a[name]')?.getAttribute('name') ?? '') || name;
      const block = li.querySelector('div.block');
      const descriptionText = block ? nodeText(block) : '';
      const dl = li.querySelector('dl');
      const notes = parseNotes(dl as HTMLElement | null);
      const params = parseItems(notes['Parameters']);
      const kindStr = signature.includes('(') ? 'method' : 'field';
      members.push({
        kind: memberKind(kindStr),
        name,
        signature,
        anchor,
        description: descriptionText,
        fullDescription: descriptionText,
        modifiers: signature,
        parameters: params.length ? params.map((p) => ({ name: p.name, type: p.name, description: p.description })) : undefined,
        returns: notes['Returns']?.[0],
        throws: notes['Throws'] ? parseItems(notes['Throws']).map((t) => ({ type: t.name, description: t.description })) : undefined,
        since: notes['Since']?.[0],
        deprecated: undefined,
        specNote: notes['Specified by']?.[0] || notes['Overrides']?.[0] || undefined,
        url,
      });
    }
  }

  return { title, declaration, description, deprecated, since: undefined, superClass: superClassMatch?.[1], interfaces, kind, members, legacy: true };
}

export function parseClassPage(html: string, url: string, qualifiedName?: string): RawClassPage {
  const root = parse(html);
  const hasModern = root.querySelector('div.member-signature') !== null;
  const parsed = hasModern ? parseModern(root, url) : parseLegacy(root, url);
  // Merge qualified name when it was supplied by the caller (authoritative from the index).
  return { ...parsed };
}

/** Build the full summary (methods / fields / constructors) from the parsed page. */
export function summarizePage(page: RawClassPage): {
  fields: MemberSummary[];
  constructors: MemberSummary[];
  methods: MemberSummary[];
  enumConstants: MemberSummary[];
} {
  const fields: MemberSummary[] = [];
  const constructors: MemberSummary[] = [];
  const methods: MemberSummary[] = [];
  const enumConstants: MemberSummary[] = [];
  for (const m of page.members) {
    const sum: MemberSummary = { kind: m.kind, name: m.name, signature: m.signature, description: m.description, anchor: m.anchor };
    switch (m.kind) {
      case 'field':
        fields.push(sum);
        break;
      case 'constructor':
        constructors.push(sum);
        break;
      case 'enum-constant':
        enumConstants.push(sum);
        break;
      case 'method':
      case 'annotation-element':
        methods.push(sum);
        break;
      default:
        methods.push(sum);
    }
  }
  return { fields, constructors, methods, enumConstants };
}

/** Locate a member detail by its anchor id inside the page. */
export function findMemberByAnchor(page: RawClassPage, anchor: string): MemberDetail | undefined {
  const normalized = (a: string) => a.replace(/\s+/g, '').toLowerCase();
  const target = normalized(anchor);
  return page.members.find((m) => normalized(m.anchor) === target || normalized(m.name) === target);
}

/** Extract a standalone member detail from raw HTML by anchor id. */
export function extractMember(html: string, url: string, anchor: string): MemberDetail | undefined {
  const root = parse(html);
  const normalized = (a: string) => a.replace(/\s+/g, '').toLowerCase();
  const target = normalized(anchor);
  const section = root.querySelector(`section[id="${cssEscapeId(anchor)}"], [data-anchor="${cssEscapeId(anchor)}"]`);
  const sigEl = section ? section.querySelector('div.member-signature') : null;
  if (sigEl) {
    const kindStr = section?.classNames?.includes('field') ? 'field' : section?.classNames?.includes('constructor') ? 'constructor' : 'method';
    return memberFromSignature(sigEl as HTMLElement, memberKind(kindStr), url, 0);
  }
  // Legacy: anchor is an <a name="..."> inside li.blockList
  const legacyLi = root.querySelector(`a[name="${cssEscapeId(anchor)}"]`)?.closest('li.blockList');
  if (legacyLi) {
    const pre = legacyLi.querySelector('pre');
    if (pre) {
      const name = clean(legacyLi.querySelector('h4')?.text ?? '');
      const signature = clean(pre.text ?? '');
      const block = legacyLi.querySelector('div.block');
      const dl = legacyLi.querySelector('dl');
      const notes = parseNotes(dl as HTMLElement | null);
      return {
        kind: signature.includes('(') ? 'method' : 'field',
        name,
        signature,
        anchor,
        description: block ? nodeText(block as HTMLElement) : '',
        fullDescription: block ? nodeText(block as HTMLElement) : '',
        modifiers: signature,
        parameters: undefined,
        returns: notes['Returns']?.[0],
        throws: undefined,
        since: notes['Since']?.[0],
        deprecated: undefined,
        url,
      };
    }
  }
  return undefined;
}

function cssEscapeId(id: string): string {
  return id.replace(/(["\\])/g, '\\$1');
}
