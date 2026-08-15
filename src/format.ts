import { ClassDoc, MemberDetail, MemberSummary, PackageEntry, SearchResult } from './types.js';

export function formatSearchResults(results: SearchResult[], query: string): string {
  if (results.length === 0) return `No classes found matching "${query}".`;
  const lines = [`### Classes matching "${query}"`, ''];
  for (const r of results) {
    const mod = r.module ? ` (module ${r.module})` : '';
    lines.push(`- **\`${r.name}\`** — ${r.kind}${mod}`);
  }
  lines.push('', 'Use `get_class` with one of the fully qualified names above for full details.');
  return lines.join('\n');
}

export function formatClassDoc(doc: ClassDoc): string {
  const lines: string[] = [];
  lines.push(`# ${doc.qualifiedName}`);
  lines.push('');
  lines.push(`**${doc.kind}** \`${doc.qualifiedName}\``);
  if (doc.module) lines.push(`Module: ${doc.module}`);
  lines.push(`Package: ${doc.packageName || '(default)'}`);
  lines.push(`URL: ${doc.url}`);
  if (doc.deprecated) lines.push('**DEPRECATED**');
  if (doc.since) lines.push(`Since: ${doc.since}`);
  lines.push('');
  lines.push(`\`\`\`java`);
  lines.push(doc.declaration);
  lines.push('```');
  if (doc.superClass) lines.push(`extends ${doc.superClass}`);
  if (doc.interfaces.length) lines.push(`implements ${doc.interfaces.join(', ')}`);
  if (doc.description) {
    lines.push('');
    lines.push(doc.description);
  }
  lines.push('');

  const sections: Array<[string, MemberSummary[], (m: MemberSummary) => string]> = [
    ['Fields', doc.fields, (m) => `- \`${m.signature || m.name}\` — ${oneLine(m.description)}`],
    ['Constructors', doc.constructors, (m) => `- \`${m.signature || m.name}\` — ${oneLine(m.description)}`],
    ['Methods', doc.methods, (m) => `- \`${m.signature || m.name}\` — ${oneLine(m.description)}`],
  ];
  if (doc.enumConstants.length) {
    sections.unshift(['Enum Constants', doc.enumConstants, (m) => `- \`${m.name}\` — ${oneLine(m.description)}`]);
  }
  for (const [title, members, render] of sections) {
    if (members.length === 0) continue;
    lines.push(`## ${title} (${members.length})`);
    lines.push('');
    const shown = members.slice(0, 120);
    lines.push(...shown.map(render));
    if (members.length > shown.length) {
      lines.push(`*…and ${members.length - shown.length} more members*`);
    }
    lines.push('');
  }

  lines.push('Use `get_member` with the class name and a member name to get the full signature, parameters, returns and throws for any member.');
  return lines.join('\n');
}

export function formatMember(member: MemberDetail, className: string): string {
  const lines: string[] = [];
  const header = member.kind === 'constructor' ? className.split('.').pop() : member.name;
  lines.push(`## ${header}`);
  lines.push('');
  lines.push(`Class: \`${className}\``);
  lines.push(`Kind: ${member.kind}`);
  if (member.deprecated) lines.push('**DEPRECATED**');
  lines.push('');
  lines.push('```java');
  lines.push(member.signature || member.name);
  lines.push('```');
  if (member.fullDescription || member.description) {
    lines.push('');
    lines.push(member.fullDescription || member.description);
  }
  if (member.parameters?.length) {
    lines.push('');
    lines.push('**Parameters:**');
    for (const p of member.parameters) {
      lines.push(`- \`${p.name}\` — ${p.description || ''}`);
    }
  }
  if (member.returns) {
    lines.push('');
    lines.push(`**Returns:** ${member.returns}`);
  }
  if (member.throws?.length) {
    lines.push('');
    lines.push('**Throws:**');
    for (const t of member.throws) {
      lines.push(`- \`${t.type}\` — ${t.description || ''}`);
    }
  }
  if (member.since) {
    lines.push('');
    lines.push(`**Since:** ${member.since}`);
  }
  if (member.specNote) {
    lines.push('');
    lines.push(`**Note:** ${member.specNote}`);
  }
  lines.push('');
  lines.push(`Source: ${member.url}#${member.anchor}`);
  return lines.join('\n');
}

export function formatMemberList(members: MemberSummary[], className: string, query: string): string {
  if (members.length === 0) return `No members of ${className} match "${query}".`;
  const lines = [`### Members of \`${className}\` matching "${query}"`, ''];
  for (const m of members.slice(0, 40)) {
    if (m.qualifiedName) {
      lines.push(`- \`${m.name}\` — in \`${m.qualifiedName}\` (use get_member with this class)`);
    } else {
      lines.push(`- \`${m.signature || m.name}\` — ${oneLine(m.description)}`);
    }
  }
  if (members.length > 40) lines.push(`*…and ${members.length - 40} more*`);
  lines.push('', 'Use `get_member` for the full signature, parameters, returns and throws.');
  return lines.join('\n');
}

export function formatPackages(packages: PackageEntry[]): string {
  if (packages.length === 0) return 'No packages found.';
  const lines = [`### Packages (${packages.length})`, ''];
  for (const p of packages) {
    lines.push(`- \`${p.name}\`${p.module ? ` (module ${p.module})` : ''}`);
  }
  lines.push('', 'Use `list_classes` with a package name to list its types, or `get_class` to fetch a type.');
  return lines.join('\n');
}

export function formatClasses(className: string, types: Array<{ label: string; package: string; kind?: string }>): string {
  if (types.length === 0) return `No classes found in package \`${className}\`.`;
  const lines = [`### Types in package \`${className}\` (${types.length})`, ''];
  for (const t of types) {
    const qualified = t.package ? `${t.package}.${t.label}` : t.label;
    lines.push(`- \`${qualified}\`${t.kind && t.kind !== 'class' ? ` — ${t.kind}` : ''}`);
  }
  lines.push('', 'Use `get_class` with a fully qualified name above for details.');
  return lines.join('\n');
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= 200) return t;
  return t.slice(0, 200).trimEnd() + '…';
}
