import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

export const __dirname = dirname(fileURLToPath(import.meta.url));

export const padString = (string, endSymbol = '…', maxLength = 50) => {
  if (string.length <= maxLength) {
    return string;
  }
  const stringFinalLength = maxLength - endSymbol.length;
  const paddedString = string.slice(0, stringFinalLength);
  return `${paddedString}${endSymbol}`;
};

export const asyncTimeout = async (ms, cb = (() => {})) => new Promise((res) => {
  setTimeout(() => res(cb()), ms);
});

export const take = (array, count) => {
  const chunk = array.filter((e, i) => i < count);
  const tail = array.filter((e, i) => i >= count);
  return { chunk, tail };
};

export const toStr = (json) => {
  try {
    return JSON.stringify(json, null, 1);
  } catch (e) {
    return `${e.message}; ${JSON.stringify(e, null, 1)}`;
  }
};

export const buildDataPath = (filename, ext = 'json') => path.join(__dirname, '..', 'data', `${filename}.${ext}`);
export const buildVideoPath = (filename, ext = 'mp4') => path.join(__dirname, '..', 'videos', `${filename}.${ext}`);
export const writeFile = (filepath, data) => fs.promises.writeFile(filepath, data, 'utf-8');
export const readFile = (filepath) => fs.promises.readFile(filepath, 'utf-8').then((data) => JSON.parse(data));

export const createChunkLoader = (
  datasets,
  preparePromise,
  fileWriter = () => {},
  params = {},
  chunkLogger = () => {},
) => async () => {
  const defaultParams = {
    chunkSize: 100,
    timeoutMS: 500,
  };
  const { chunkSize, timeoutMS } = { ...defaultParams, ...params };
  const total = datasets.length;
  let all = datasets;
  let count = 0;

  do {
    const { chunk, tail } = take(all, chunkSize);
    const promises = chunk.map(preparePromise);
    await Promise.all(promises).then(fileWriter);
    await asyncTimeout(timeoutMS);
    count += chunk.length;
    all = tail;
    chunkLogger({ count, total });
  } while (all.length > 0);
};
