import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// fastify
import fastify from 'fastify';
// libs
import ms from 'ms';
import _ from 'lodash';
import * as luxon from 'luxon';
// app
import configValidator from '../utils/configValidator.js';
import { bodyFixture } from '../../data/fixture.mjs';
import { CronService } from '../libs/CronService.js';
import {
  padString,
  downloadZoomFile,
  buildVideoPath,
  buildDataPath,
} from '../utils/helpers.js';

const { DateTime } = luxon;

const loadingStates = ['ready', 'loading', 'success', 'failed'];
const loadingStatesEnum = loadingStates.reduce((acc, state) => {
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
    const topicCountMap = new Map();

    return server.storage
      .read()
      .then((items) => {
        const operations = [];

        items.forEach((item, itemIndex) => {
          if (itemsInProcessing.has(itemIndex)) return true;

          itemsInProcessing.add(itemIndex);
          const { payload, download_token, loadingState } = item;
          const {
            topic,
            duration,
            recording_files,
            start_time,
            account_id
          } = payload.object;
          const preparedTopic = topic.trim().replace(' ', '');

          const videoRecords = recording_files.filter(({ recording_type, status }) => (
            (recording_type === 'shared_screen_with_speaker_view')
            && (status === 'completed')
          ));

          const notHasVideo = videoRecords.length === 0;
          const isTooShort = (duration < 5); // если запись менее 5 минут
          const isLoaded = loadingState === loadingStatesEnum.success;
          const isLoading = loadingState === loadingStatesEnum.loading;

          if (notHasVideo || isTooShort || isLoaded || isLoading) {
            return true;
          }

          if (!topicCountMap.has(preparedTopic)) {
            topicCountMap.set(preparedTopic, 0);
          }
          const topicPrevIndex = topicCountMap.get(preparedTopic);
          const topicIndex = topicPrevIndex + 1;
          topicCountMap.set(preparedTopic, topicIndex);

          if (loadingState === loadingStatesEnum.ready) {
            const parsedTopic = parseTopic(preparedTopic);
            item.loadingState = loadingStatesEnum.loading;
            const recordMeta = {
              "loadingState": loadingStatesEnum.loading,
              "loadingError": "",
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
              const postfix = `;файл ${topicIndex}`;

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
                .update(item, itemIndex)
                .then(() => downloadZoomFile({
                  filepath: recordMeta.filepath,
                  url: record.download_url,
                  token: download_token,
                }))
                .then(() => {
                  recordMeta.loadingState = loadingStatesEnum.success;
                  item.loadingState = loadingStatesEnum.success;
                  return server.storage.update(item, itemIndex);
                })
                .catch(err => {
                  console.error(err);
                  recordMeta.loadingError = err.message;
                  recordMeta.loadingState = loadingStatesEnum.failed;
                  item.loadingState = loadingStatesEnum.failed;
                  return server.storage.update(item, itemIndex);
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

  const route = {
    method: 'POST',
    url: `/${config.ROUTE_UUID}`,
    handler(req, res) {
      const { body } = req;
      const data = bodyFixture;
      data.loadingState = loadingStatesEnum.ready;

      this.storage.add(bodyFixture)
        .then(() => res.code(200).send('ok'))
        .catch((err) => {
          console.error(err);
          res.code(400).send(err.message);
        });
    },
  };

  server.route(route);

  return server;
};

const initIncomingDataStorage = async (server) => {
  const dirpathVideo = path.dirname(buildVideoPath(server.config.STORAGE_DIRPATH));
  if (!fs.existsSync(dirpathVideo)) {
    fs.mkdirSync(dirpathVideo);
  }

  const filepath = buildDataPath(server.config.STORAGE_DIRPATH, 'incoming');
  const dirpath = path.dirname(filepath);
  if (!fs.existsSync(dirpath)) {
    fs.mkdirSync(dirpath);
  }
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, JSON.stringify([]));
  }

  return fs
    .promises
    .readFile(filepath)
    .then((data) => {
      const json = JSON.parse(data);

      const storage = {
        read: () => Promise.resolve(json),
        update: (data, index) => {
          json[index] = data;
          return fs
            .promises
            .writeFile(filepath, JSON.stringify(json));
        },
        add: (data) => {
          json.push(data);
          return fs
            .promises
            .writeFile(filepath, JSON.stringify(json));
        },
      };

      server.decorate('storage', storage);
    });
};

const app = async (envName) => {
  process.on('unhandledRejection', (err) => {
    console.error(err);
    process.exit(1);
  });

  const config = await configValidator(envName);
  const server = initServer(config);

  server.decorate('config', config);

  await initIncomingDataStorage(server);
  const cronJob = initTasks(server);


  const stop = async () => {
    server.log.info('Stop app', config);
    server.log.info('  Stop cron');
    await cronJob.stop();
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
