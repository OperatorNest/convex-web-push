interface ImportMeta {
  glob<T = unknown>(pattern: string | string[]): Record<string, () => Promise<T>>;
}
