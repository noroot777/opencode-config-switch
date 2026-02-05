import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureUserDataFile = async () => {
  const userDataPath = app.getPath("userData");
  const storagePath = path.join(userDataPath, "profiles.jsonl");
  try {
    await fs.access(storagePath);
  } catch {
    await fs.mkdir(userDataPath, { recursive: true });
    await fs.writeFile(storagePath, "", "utf-8");
  }
  return storagePath;
};

const readJsonl = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

const writeJsonl = async (filePath, records) => {
  const content = records.map((r) => JSON.stringify(r)).join("\n");
  await fs.writeFile(filePath, content + (content ? "\n" : ""), "utf-8");
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const resolvedDevServerUrl = devServerUrl
    ? devServerUrl.replace("localhost", "127.0.0.1")
    : null;
  Menu.setApplicationMenu(null);
  if (resolvedDevServerUrl) {
    win.loadURL(resolvedDevServerUrl);
  } else {
    const indexPath = path.join(__dirname, "../dist/index.html");
    win.loadFile(indexPath);
  }
};

app.whenReady().then(async () => {
  await ensureUserDataFile();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("storage:read", async () => {
  const storagePath = await ensureUserDataFile();
  return readJsonl(storagePath);
});

ipcMain.handle("storage:write", async (_event, records) => {
  const storagePath = await ensureUserDataFile();
  await writeJsonl(storagePath, records);
  return true;
});

ipcMain.handle("storage:export", async (_event, records) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "导出配置",
    defaultPath: "profiles.jsonl",
    filters: [{ name: "JSONL", extensions: ["jsonl"] }],
  });
  if (canceled || !filePath) return null;
  await writeJsonl(filePath, records);
  return filePath;
});

ipcMain.handle("storage:import", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "导入配置",
    properties: ["openFile"],
    filters: [{ name: "JSONL", extensions: ["jsonl"] }],
  });
  if (canceled || !filePaths || filePaths.length === 0) return null;
  const records = await readJsonl(filePaths[0]);
  return records;
});

ipcMain.handle("fs:read", async (_event, filePath) => {
  const content = await fs.readFile(filePath, "utf-8");
  return content;
});

ipcMain.handle("fs:write", async (_event, filePath, content) => {
  await fs.writeFile(filePath, content, "utf-8");
  return true;
});

ipcMain.handle("dialog:openJson", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "选择 JSON 文件",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (canceled || !filePaths || filePaths.length === 0) return null;
  return filePaths[0];
});
