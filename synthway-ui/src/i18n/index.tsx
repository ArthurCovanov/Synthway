import { createContext, Fragment, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { loadJson, usePersistentState } from '../lib/storage';
import en from './locales/en.json';
import fr from './locales/fr.json';

// The UI's texts live in one file per language (locales/). A text is found by
// its key, "namespace.name", and may hold placeholders: {name}, replaced by a
// parameter, and <tag>…</tag>, wrapped by a React element (rich texts, `tr`).
// A key with the variants name_one and name_other is a plural: the parameter
// `count` picks the variant, by the plural rules of the language.

export type Language = 'en' | 'fr';

/** The languages offered in the Settings, each one named in its own language */
export const LANGUAGES: readonly { id: Language; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'fr', name: 'Français' },
];

export const DEFAULT_LANGUAGE: Language = 'en';

/** Locale of each language, for numbers */
const LOCALES: Record<Language, string> = { en: 'en-US', fr: 'fr-FR' };

const STORAGE_KEY = 'synthway.language.v1';

interface Tree {
  [key: string]: string | Tree;
}

const MESSAGES: Record<Language, Tree> = { en, fr };

/** "a.b.c" for each text of a messages tree */
type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

type WithoutPlural<K> = K extends `${infer Base}_one` ? Base : K extends `${infer Base}_other` ? Base : K;

/** Every key of the texts; a plural is called by its name, without _one or _other */
export type MessageKey = WithoutPlural<Leaves<typeof fr>>;

// The two files have the same keys: a key that one of them lacks is a type error
// here, which names it
const missingInEnglish: Record<Exclude<Leaves<typeof fr>, Leaves<typeof en>>, never> = {};
const missingInFrench: Record<Exclude<Leaves<typeof en>, Leaves<typeof fr>>, never> = {};
void missingInEnglish;
void missingInFrench;

export type MessageParams = Record<string, string | number>;
/** Parameters of a rich text: nodes for {name}, wrappers for <tag>…</tag> */
export type RichParams = Record<string, ReactNode | ((inner: ReactNode) => ReactNode)>;

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.id === value);
}

/** The current language, for code outside components; LanguageProvider keeps it up to date */
let current: Language = (() => {
  const saved = loadJson<unknown>(STORAGE_KEY, undefined);
  return isLanguage(saved) ? saved : DEFAULT_LANGUAGE;
})();

export function getLanguage(): Language {
  return current;
}

function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

const pluralRules = new Map<Language, Intl.PluralRules>();

function pluralForm(language: Language, count: number): string {
  let rules = pluralRules.get(language);
  if (!rules) {
    rules = new Intl.PluralRules(LOCALES[language]);
    pluralRules.set(language, rules);
  }
  return rules.select(count);
}

/** The raw text of a key: the plural variant `count` asks for, else the English text, else the key itself */
function message(language: Language, key: string, count: unknown): string {
  for (const lang of language === DEFAULT_LANGUAGE ? [language] : [language, DEFAULT_LANGUAGE]) {
    const tree = MESSAGES[lang];
    if (typeof count === 'number') {
      const plural = lookup(tree, `${key}_${pluralForm(lang, count)}`) ?? lookup(tree, `${key}_other`);
      if (plural !== undefined) return plural;
    }
    const text = lookup(tree, key);
    if (text !== undefined) return text;
  }
  return key;
}

export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
  const text = message(language, key, params?.count);
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}

const RICH_PATTERN = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)\}/g;

function richNodes(text: string, params: RichParams): ReactNode[] {
  const nodes: ReactNode[] = [];
  // A pattern of its own: richNodes calls itself for the inside of a tag
  const pattern = new RegExp(RICH_PATTERN.source, 'g');
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [whole, tag, inner, name] = match;
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (tag !== undefined) {
      const wrap = params[tag];
      const content = richNodes(inner, params);
      nodes.push(typeof wrap === 'function' ? wrap(content) : content);
    } else {
      const value = params[name];
      nodes.push(value === undefined || typeof value === 'function' ? whole : value);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}

/** A text with React elements in it: {name} takes a node, <tag>…</tag> a function that wraps its inside */
export function translateRich(language: Language, key: MessageKey, params: RichParams): ReactNode {
  const count = params.count;
  return richNodes(message(language, key, count), params);
}

export function formatNumberIn(language: Language, value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(LOCALES[language], options);
}

// For code outside components (lib/, labels computed on demand). In a
// component, prefer useI18n(): the component then renders again when the
// language changes.

export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

export function tr(key: MessageKey, params: RichParams): ReactNode {
  return translateRich(current, key, params);
}

/** A number written the way the current language writes it (1.5 / 1,5) */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return formatNumberIn(current, value, options);
}

interface I18nValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
  tr: (key: MessageKey, params: RichParams) => ReactNode;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = usePersistentState<Language>(
    STORAGE_KEY,
    () => current,
    (saved) => (isLanguage(saved) ? saved : DEFAULT_LANGUAGE),
  );
  // Set before the children render, so that t() outside components agrees with them
  current = language;

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18nValue>(
    () => ({
      language,
      setLanguage,
      t: (key, params) => translate(language, key, params),
      tr: (key, params) => translateRich(language, key, params),
      formatNumber: (number, options) => formatNumberIn(language, number, options),
    }),
    [language, setLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The texts in the current language; the component renders again when it changes */
export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n must be used inside <LanguageProvider>');
  }
  return value;
}
