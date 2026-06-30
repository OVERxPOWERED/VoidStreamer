const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  scrapeUrl:          (url, config) => ipcRenderer.invoke('scrape-url',            { url, config }),
  scrapeDetail:       (url, config) => ipcRenderer.invoke('scrape-detail',         { url, config }),
  scrapeMoviboxStream:(url)         => ipcRenderer.invoke('scrape-movibox-stream',  { url }),
  scrapeSpa:          (url, jsCode) => ipcRenderer.invoke('scrape-spa',            { url, jsCode }),
  scrapeKawaiiVideo:  (url)         => ipcRenderer.invoke('scrape-kawaii-anime-video', { url }),
  scrapeAnimeSourceVideo: (url, lang) => ipcRenderer.invoke('scrape-anime-source-video', { url, lang }),
  startDownload:      (url, title, quality, image) => ipcRenderer.invoke('start-download', { url, title, quality, image }),
  pauseDownload:      (downloadId) => ipcRenderer.invoke('download-pause', { downloadId }),
  resumeDownload:     (downloadId) => ipcRenderer.invoke('download-resume', { downloadId }),
  cancelDownload:     (downloadId) => ipcRenderer.invoke('download-cancel', { downloadId }),
  analyzeStream:      (url, quick)   => ipcRenderer.invoke('analyze-stream', { url, quick }),
  readFile:           (filePath)    => ipcRenderer.invoke('read-file', { filePath }),
  writeFile:          (filePath, data) => ipcRenderer.invoke('write-file', { filePath, data }),
  remuxTsToMp4:       (tsPath, mp4Path, downloadId) => ipcRenderer.invoke('remux-ts-to-mp4', { tsPath, mp4Path, downloadId }),
  onDownloadStarted:  (cb) => ipcRenderer.on('download-started',  (e, d) => cb(d)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d)),
  onDownloadDone:     (cb) => ipcRenderer.on('download-done',     (e, d) => cb(d)),
  cacheVideo:          (url, title)   => ipcRenderer.invoke('cache-video', { url, title }),
  onCacheProgress:     (cb)           => { const fn = (e, d) => cb(d); ipcRenderer.on('cache-progress', fn); return () => ipcRenderer.removeListener('cache-progress', fn); },
  removeDownloadListeners: () => {
    ipcRenderer.removeAllListeners('download-started');
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.removeAllListeners('download-done');
  },
  openExternal:       (url)         => ipcRenderer.send('open-external', url),
  playLocalFile:      (path)        => ipcRenderer.invoke('play-local-file', path)
});

