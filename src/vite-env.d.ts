/// <reference types="vite/client" />

interface Window {
  api?: {
    readStorage: () => Promise<unknown>;
    writeStorage: (data: unknown) => Promise<boolean>;
    exportStorage: (data: unknown) => Promise<string | null>;
    importStorage: () => Promise<unknown | null>;
    openJsonFile: () => Promise<string | null>;
    readFile: (filePath: string) => Promise<string>;
    writeFile: (filePath: string, content: string) => Promise<boolean>;
  };
}
