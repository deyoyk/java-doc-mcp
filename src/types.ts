export type TypeKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'annotation'
  | 'record'
  | 'exception'
  | 'unknown';

export type MemberKind = 'method' | 'constructor' | 'field' | 'enum-constant' | 'annotation-element' | 'unknown';

export interface TypeEntry {
  /** Simple name or nested name as it appears in the index (e.g. `ConcurrentHashMap` or `ThreadPoolExecutor.AbortPolicy`). */
  label: string;
  /** Fully qualified package name. */
  package: string;
  /** Kind category if the index provides one (modern javadoc `c` field). */
  kind?: TypeKind;
  /** Owning module when the docs are modular (JDK 9+), derived from the package index. */
  module?: string;
}

export interface PackageEntry {
  name: string;
  module?: string;
}

export interface MemberEntry {
  package: string;
  className: string;
  name: string;
}

export interface DocIndex {
  /** Every type indexed by the site. */
  types: TypeEntry[];
  /** Every package indexed by the site. */
  packages: PackageEntry[];
  /** Every member indexed by the site (modern javadoc only). */
  members: MemberEntry[];
  /** Full text of the raw index, kept for detail queries. */
  loadedAt: number;
}

export interface MemberSummary {
  kind: MemberKind;
  name: string;
  signature: string;
  description: string;
  anchor: string;
  /** Fully qualified class name when the hit came from the site-wide member index. */
  qualifiedName?: string;
}

export interface MemberDetail extends MemberSummary {
  modifiers: string;
  fullDescription: string;
  parameters?: { name: string; type: string; description: string }[];
  returns?: string;
  throws?: { type: string; description: string }[];
  since?: string;
  deprecated?: string;
  specNote?: string;
  url: string;
}

export interface ClassDoc {
  qualifiedName: string;
  simpleName: string;
  packageName: string;
  module?: string;
  kind: TypeKind;
  declaration: string;
  description: string;
  superClass?: string;
  interfaces: string[];
  inherited?: string[];
  fields: MemberSummary[];
  constructors: MemberSummary[];
  methods: MemberSummary[];
  enumConstants: MemberSummary[];
  deprecated: boolean;
  since?: string;
  url: string;
  legacy?: boolean;
}

export interface SearchResult {
  name: string;
  package: string;
  kind: TypeKind;
  module?: string;
  score: number;
  url: string;
}
