import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// fastify
import fastify from 'fastify';
// libs
import ms from 'ms';
import _ from 'lodash';
import * as luxon from 'luxon';
import sqlite3 from 'sqlite3';
import * as sqlite from 'sqlite';
// app
import configValidator from '../utils/configValidator.js';
import { bodyFixture } from '../../fixtures/fixture.mjs';
import { CronService } from '../libs/CronService.js';
import {
  padString,
  downloadZoomFile,
  buildVideoPath,
  buildDataPath,
  writeFile,
} from '../utils/helpers.js';

const { DateTime } = luxon;

const loadStateEnum = ['ready', 'loading', 'success', 'failed'].reduce((acc, state) => {
  acc[state] = state;
  return acc;
}, {});

const topicEnum = ['other', 'hexlet', 'college'].reduce((acc, state) => {
  acc[state] = state;
  return acc;
}, {});
const parseTopic = (topic) => {
  const parts = topic.split(';').map((item) => item.trim());
  let type = topicEnum.other;
  if (parts.length < 3) {
    return { type };
  }
  const [theme = '', tutor = '', potok = ''] = parts;
  const potokLC = potok.trim().toLowerCase();
  const isHexletTopic = potokLC.startsWith('potok');
  const isCollegeTopic = potokLC.startsWith('колледж');
  if (isHexletTopic) {
    type = topicEnum.hexlet;
  } else if (isCollegeTopic) {
    type = topicEnum.college;
  }
  return {
    theme: theme.trim(),
    tutor: tutor.trim(),
    potok: potokLC,
    type,
  };
};

const initTasks = (server) => {
  const itemsInProcessing = new Set();

  const downloadTask = () => {
    return server.storage
      .read()
      .then((items) => {
        const operations = [];

        items.forEach((item) => {
          const { id, loadFromZoomState, data } = item;
          const { payload, download_token } = data;
          const {
            topic,
            duration,
            recording_files,
            start_time,
            account_id
          } = payload.object;
          const preparedTopic = topic.trim().replace(' ', '');
          const isTooShort = (duration < 5); // если запись менее 5 минут
          const isLoaded = (loadFromZoomState === loadStateEnum.success);
          const isLoading = (loadFromZoomState === loadStateEnum.loading);
          const isProcessing = itemsInProcessing.has(id);

          const videoRecords = recording_files.filter(({ recording_type, status }) => (
            (recording_type === 'shared_screen_with_speaker_view')
            && (status === 'completed')
          ));
          const notHasVideo = videoRecords.length === 0;

          if (notHasVideo || isTooShort || isLoaded || isLoading || isProcessing) {
            return true;
          }
          itemsInProcessing.add(id);

          if (loadFromZoomState === loadStateEnum.ready) {
            const parsedTopic = parseTopic(preparedTopic);
            item.loadFromZoomState = loadStateEnum.loading;

            const recordMeta = {
              "loadFromZoomState": loadStateEnum.loading,
              "loadToYoutubeState": loadStateEnum.loading,
              "downloadError": "",
              "isHexletTopic": (parsedTopic.type === topicEnum.hexlet),
              "isCollegeTopic": (parsedTopic.type === topicEnum.college),
              "date": DateTime.fromISO(start_time).setZone('Europe/Moscow').toFormat('dd.LL.yyyy'),
              "topicName": "",
              "topicAuthor": "",
              "topicPotok": "",
              "meetingId": "",
              "filename": "",
              "extension": "",
              "filepath": "",
              "youtubeDescription": "",
              "youtubeName": "",
              "youtubePlaylist": "",
              "youtubeUrl": "",
              "zoomAuthorId": account_id,
            };

            const genPrefix = (index) => (videoRecords.length > 1 ? `Часть ${index + 1}, ` : '');
            videoRecords.forEach((record, recordIndex) => {
              const prefix = genPrefix(recordIndex);
              const postfix = `;файл ${id}-${recordIndex}`;

              if (recordMeta.isHexletTopic || recordMeta.isCollegeTopic) {
                const {
                  theme, tutor, potok,
                } = parsedTopic;
                // общая длина названия должна быть не более 100 символов. Это нужно и ютубу, и файловой системе.
                // примерно так по символам: (10 префикс) + (50 тема) + (15 дата) + (25 имя автора)
                // + 6-8 символов на постфикс для файловой системы
                const trimmedTutor = `${tutor ? `; ${padString(tutor, 25)}` : ''}`;
                recordMeta.topicName = `${padString(`${prefix}${theme}`, 60)} от ${recordMeta.date}${trimmedTutor}`;
                recordMeta.topicAuthor = tutor;
                recordMeta.topicPotok = potok;
                recordMeta.youtubePlaylist = potok;

                recordMeta.youtubeDescription = [
                  `* Полное название: ${theme}`,
                  `* Дата: ${recordMeta.date}`,
                  tutor ? `* Автор: ${tutor}` : '',
                  `* Поток: ${potok}`,
                ].filter((x) => x).join('\n');
              } else {
                recordMeta.topicName = `${padString(`${prefix}${preparedTopic}`, 85)} от ${recordMeta.date}`;
                recordMeta.youtubeDescription = [
                  `* Полное название: ${preparedTopic}`,
                  `* Дата: ${recordMeta.date}`,
                  `* Дата: ${recordMeta.zoomAuthorId}`,
                ].join('\n');
                recordMeta.youtubePlaylist = 'Other';
              }

              recordMeta.extension = record.file_extension.toLowerCase();
              recordMeta.filename = `${recordMeta.topicName}${postfix}`
                .replace(/[/|\\]/gim, '|')
                .replace(/\s+/gim, '_')
                .trim();
              recordMeta.filepath = buildVideoPath(
                server.config.STORAGE_DIRPATH,
                recordMeta.filename,
                recordMeta.extension,
              );
              record.meta = recordMeta;

              const operation = () => server.storage
                .update(item)
                // .then(() => downloadZoomFile({
                //   filepath: recordMeta.filepath,
                //   url: record.download_url,
                //   token: download_token,
                // }))
                .then(() => {
                  recordMeta.loadFromZoomState = loadStateEnum.success;
                  item.loadFromZoomState = loadStateEnum.success;
                  return server.storage.update(item);
                })
                .catch(err => {
                  console.error(err);
                  recordMeta.downloadError = err.message;
                  recordMeta.loadFromZoomState = loadStateEnum.failed;
                  item.loadFromZoomState = loadStateEnum.failed;
                  return server.storage.update(item);
                });
              operations.push(() => operation());
            });
          }
        });

        return Promise.all(operations.map(operation => operation()));
      });
  };

  const task = new CronService(
    downloadTask,
    ms(server.config.CRON_PERIOD),
    ms(server.config.CRON_DELAY),
  );
  return task;
};

const initServer = (config) => {
  const pinoPrettyTransport = {
    transport: {
      target: 'pino-pretty',
    },
  };
  const transport = config.IS_DEV_ENV ? pinoPrettyTransport : {};
  const server = fastify({
    logger: {
      ...transport,
      level: config.LOG_LEVEL,
    },
  });
  server.decorate('config', config);

  const route = {
    method: 'POST',
    url: `/${config.ROUTE_UUID}`,
    handler(req, res) {
      const { body } = req;
      const data = bodyFixture;

      this.storage
        .add({
          loadFromZoomState: loadStateEnum.ready,
          loadToYoutubeState: loadStateEnum.ready,
          data,
        })
        .then(() => res.code(200).send('ok'))
        .then(console.log)
        .catch((err) => {
          console.error(err);
          res.code(400).send(err.message);
        });
    },
  };

  server.route(route);

  return server;
};

const initDatabase = async (server) => {
  const dbFilepath = buildDataPath(server.config.STORAGE_DIRPATH, 'database', 'db');
  const dbDirpath = path.dirname(dbFilepath);
  if (!fs.existsSync(dbDirpath)) {
    fs.mkdirSync(dbDirpath);
  }

  const db = await sqlite.open({
    filename: dbFilepath,
    driver: sqlite3.Database,
  });

  await db.migrate();

  if (server.config.IS_DEV_ENV) {
    sqlite3.verbose();
  }

  const storage = {
    read: (where = {}) => {
      const whereKeys = Object.keys(where);
      const hasWhere = whereKeys.length > 0;
      let select = 'SELECT * FROM events';

      if (hasWhere) {
        const placeholders = [];
        where = whereKeys.reduce((acc, key) => {
          const placeholder = `:${key}`;
          placeholders.push(`${key}=${placeholder}`);
          acc[placeholder] = where[key];
          return acc;
        }, {});
        select = `${select} WHERE ${placeholders.join(' AND ')}`;
      }

      return db.all(select, where)
        .then((items) => items.map((item) => {
          item.data = JSON.parse(item.data);
          return item;
        }))
    },
    update: ({ id, loadFromZoomState, loadToYoutubeState, data }) => {
      const params = { loadFromZoomState, loadToYoutubeState, data: JSON.stringify(data) };
      const columns = Object.keys(params).map(name => `${name}=?`);
      const placeholders = Object.values(params);

      return db.run(
        `UPDATE events SET ${columns.join(', ')} WHERE id=(${id})`,
        ...placeholders,
      );
    },
    add: ({ loadFromZoomState, loadToYoutubeState, data }) => {
      const params = { loadFromZoomState, loadToYoutubeState, data: JSON.stringify(data) };
      const columns = Object.keys(params);
      const placeholders = [];
      const insertions = columns.reduce((acc, key) => {
        const placeholder = `:${key}`;
        placeholders.push(placeholder);
        acc[placeholder] = params[key];
        return acc;
      }, {});

      return db.run(
        `INSERT INTO events (${columns.join(',')}) VALUES (${placeholders.join(',')})`,
        insertions,
      );
    },
  };

  server.decorate('storage', storage);

  return db;
};

const app = async (envName) => {
  process.on('unhandledRejection', (err) => {
    console.error(err);
    process.exit(1);
  });

  const config = await configValidator(envName);
  const server = initServer(config);

  const db = await initDatabase(server);
  const cronJob = initTasks(server);

  const stop = async () => {
    server.log.info('Stop app', config);
    server.log.info('  Stop cron');
    await cronJob.stop();
    server.log.info('  Stop database');
    await db.close();
    server.log.info('  Stop server');
    await server.close();
    server.log.info('App stopped');

    if (!config.IS_TEST_ENV) {
      process.exit(0);
    }
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  await server.listen({ port: config.PORT, host: config.HOST });
  await cronJob.start();

  return {
    server,
    config,
    stop,
  };
};

export default app;
