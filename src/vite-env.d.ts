/// <reference types="vite/client" />

interface Window {
  api?: {
    readStorage: () => Promise<Array<Record<string, unknown>>>;
    writeStorage: (records: Array<Record<string, unknown>>) => Promise<boolean>;
    exportStorage: (records: Array<Record<string, unknown>>) => Promise<string | null>;
    importStorage: () => Promise<Array<Record<string, unknown>> | null>;
    openJsonFile: () => Promise<string | null>;
    readFile: (filePath: string) => Promise<string>;
    writeFile: (filePath: string, content: string) => Promise<boolean>;
  };
}
