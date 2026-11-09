'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('figmaScreenshots', {
  login: () => ipcRenderer.invoke('figma:login'),
  sessionStatus: () => ipcRenderer.invoke('figma:session'),
  importFirefox: () => ipcRenderer.invoke('figma:import-firefox'),
  chooseLinks: () => ipcRenderer.invoke('links:choose'),
  generateLinks: (url) => ipcRenderer.invoke('links:generate', url),
  saveLinks: (payload) => ipcRenderer.invoke('links:save', payload),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  chooseOutput: () => ipcRenderer.invoke('output:choose'),
  defaultOutput: () => ipcRenderer.invoke('output:default'),
  start: (payload) => ipcRenderer.invoke('capture:start', payload),
  stop: () => ipcRenderer.invoke('capture:stop'),
  openOutput: (directory) => ipcRenderer.invoke('output:open', directory),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('figma:event', listener);
    return () => ipcRenderer.removeListener('figma:event', listener);
  }
});
