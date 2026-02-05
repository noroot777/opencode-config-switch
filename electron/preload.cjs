const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  readStorage: () => ipcRenderer.invoke("storage:read"),
  writeStorage: (records) => ipcRenderer.invoke("storage:write", records),
  exportStorage: (records) => ipcRenderer.invoke("storage:export", records),
  importStorage: () => ipcRenderer.invoke("storage:import"),
  openJsonFile: () => ipcRenderer.invoke("dialog:openJson"),
  readFile: (filePath) => ipcRenderer.invoke("fs:read", filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke("fs:write", filePath, content),
});
