import fs from 'fs';
import path from 'path';
// fastify
import fastify from 'fastify';
// libs
import ms from 'ms';
import * as luxon from 'luxon';
import sqlite3 from 'sqlite3';
import * as sqlite from 'sqlite';
import { google } from 'googleapis';
// app
import { configValidator } from '../utils/configValidator.js';
import { bodyFixture } from '../../fixtures/fixture.mjs';
import { CronService } from '../libs/CronService.js';
import {
  padString,
  downloadZoomFile,
  buildVideoPath,
  buildDataPath,
} from '../utils/helpers.js';

const { DateTime } = luxon;

const processingStateEnum = ['ready', 'processed', 'rejected'].reduce((acc, state) => {
  acc[state] = state;
  return acc;
}, {});
const loadStateEnum = ['ready', 'success', 'failed'].reduce((acc, state) => {
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

  const oauthCallbackRoutePath = '/oauth2callback';
  const oauthRedirectURL = `${config.DOMAIN}:${config.PORT}${oauthCallbackRoutePath}`;
  const oauthClient = new google.auth.OAuth2(
    config.YOUTUBE_CLIENT_ID,
    config.YOUTUBE_CLIENT_SECRET,
    oauthRedirectURL,
  );
  server.decorate('oauthClient', oauthClient);

  const scopes = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.upload',
  ];

  const authorizationUrl = oauthClient.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    include_granted_scopes: true
  });

  const routeOauth = {
    method: 'GET',
    url: `/oauth2`,
    handler(req, res) {
      res.redirect(authorizationUrl);
    },
  };

  server.route(routeOauth);

  const routeOauthCallback = {
    method: 'GET',
    url: `${oauthCallbackRoutePath}`,
    handler(req, res) {
      if (!req.query || !req.query.code) {
        res.code(400).send(`Query must be contain parameter "code"`);
      } else {
        oauthClient
          .getToken(req.query.code)
          .then(({ tokens }) => {
            oauthClient.setCredentials(tokens);
            return server.storage.tokens.set(tokens);
          })
          .then(() => {
            res.code(200).send('ok');
          })
          .catch((err) => {
            console.error(err);
            res.code(400).send(err.message);
          });
      }
    },
  };

  server.route(routeOauthCallback);

  const routeEvents = {
    method: 'POST',
    url: `/${config.ROUTE_UUID}`,
    handler(req, res) {
      const { body } = req;
      const data = this.config.IS_DEV_ENV ? bodyFixture : body;
      const {
        topic,
        duration,
        recording_files,
        start_time,
        account_id,
      } = data.payload.object;
      const isTooShort = (duration < 5); // если запись менее 5 минут
      const videoRecords = recording_files.filter(({ recording_type, status }) => (
        (recording_type === 'shared_screen_with_speaker_view')
        && (status === 'completed')
      ));
      const notHasVideo = videoRecords.length === 0;
      const state = (notHasVideo || isTooShort)
        ? processingStateEnum.rejected
        : processingStateEnum.ready;

      this.storage.events
        .add({
          state,
          data,
        })
        .then((db) => {
          res.code(200).send('ok');
          return db;
        })
        .catch((err) => {
          console.error(err);
          res.code(400).send(err.message);
        })
        .then(({ lastID: eventId }) => {
          if (!eventId || (state === processingStateEnum.rejected)) return true;

          const preparedTopic = topic.trim().replace(' ', '');
          const parsedTopic = parseTopic(preparedTopic);

          const recordMeta = {
            isHexletTopic: (parsedTopic.type === topicEnum.hexlet),
            isCollegeTopic: (parsedTopic.type === topicEnum.college),
            date: DateTime.fromISO(start_time).setZone('Europe/Moscow').toFormat('dd.LL.yyyy'),
            topicName: '',
            topicAuthor: '',
            topicPotok: '',
            filename: '',
            filepath: '',
            youtubeDescription: '',
            youtubeName: '',
            youtubePlaylist: '',
            youtubeUrl: '',
            zoomAuthorId: account_id,
          };

          const genPrefix = (index) => (videoRecords.length > 1 ? `Часть ${index + 1}, ` : '');
          const preparedRecordsPromises = videoRecords.map((record, recordIndex) => {
            const prefix = genPrefix(recordIndex);
            const postfix = `;${eventId}-${recordIndex}`;
            record.download_token = data.download_token;

            if (recordMeta.isHexletTopic || recordMeta.isCollegeTopic) {
              const {
                theme, tutor, potok,
              } = parsedTopic;
              // общая длина названия должна быть не более 100 символов. Это нужно и ютубу, и файловой системе.
              // примерно так по символам: (10 префикс) + (50 тема) + (15 дата) + (25 имя автора)
              // + до 10 символов на постфикс для файловой системы
              const trimmedTutor = `${tutor ? `;${padString(tutor, 25)}` : ''}`;
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

            recordMeta.youtubeName = recordMeta.topicName;
            recordMeta.filename = `${recordMeta.topicName}${postfix}`
              .replace(/[/|\\]/gim, '|')
              .replace(/\s+/gim, '_')
              .trim();
            recordMeta.filepath = buildVideoPath(
              server.config.STORAGE_DIRPATH,
              recordMeta.filename,
              record.file_extension.toLowerCase(),
            );
            record.meta = recordMeta;

            return this.storage.records
              .add({
                eventId,
                loadFromZoomState: loadStateEnum.ready,
                loadToYoutubeState: loadStateEnum.ready,
                data: record,
              });
          });

          return Promise.all(preparedRecordsPromises)
            .then(() => this.storage.events.update({
              id: eventId,
              state: processingStateEnum.processed,
            }));
        });
    },
  };

  server.route(routeEvents);

  return server;
};

const initDatabase = async (server) => {
  const videoFilepath = buildVideoPath(server.config.STORAGE_DIRPATH);
  const videoDirpath = path.dirname(videoFilepath);
  if (!fs.existsSync(videoDirpath)) {
    fs.mkdirSync(videoDirpath);
  }

  const dbFilepath = buildDataPath(server.config.STORAGE_DIRPATH, 'database', 'db');
  const dbDirpath = path.dirname(dbFilepath);
  if (!fs.existsSync(dbDirpath)) {
    fs.mkdirSync(dbDirpath);
  }

  const db = await sqlite.open({
    filename: dbFilepath,
    driver: server.config.IS_DEV_ENV
      ? sqlite3.verbose().Database
      : sqlite3.Database,
  });

  await db.migrate();

  const generateQB = (tableName) => ({
    read: (where = {}) => {
      const whereKeys = Object.keys(where);
      const hasWhere = whereKeys.length > 0;
      let select = `SELECT * FROM ${tableName}`;

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
        }));
    },
    update: (params) => {
      const { id, ...fields } = params;
      if (typeof fields.data === 'object') {
        fields.data = JSON.stringify(fields.data);
      }
      const columns = Object.keys(fields);
      const placeholders = [];
      const insertions = columns.reduce((acc, key) => {
        const placeholder = `:${key}`;
        placeholders.push(`${key}=${placeholder}`);
        acc[placeholder] = fields[key];
        return acc;
      }, {});

      return db.run(
        `UPDATE ${tableName} SET ${placeholders.join(', ')} WHERE id=(${id})`,
        insertions,
      );
    },
    add: (params) => {
      params.data = JSON.stringify(params.data);
      const columns = Object.keys(params);
      const placeholders = [];
      const insertions = columns.reduce((acc, key) => {
        const placeholder = `:${key}`;
        placeholders.push(placeholder);
        acc[placeholder] = params[key];
        return acc;
      }, {});

      return db.run(
        `INSERT INTO ${tableName} (${columns.join(',')}) VALUES (${placeholders.join(',')})`,
        insertions,
      );
    },
  });

  const tokens = {
    get: () => db.get('SELECT * FROM tokens').then(({ token }) => JSON.parse(token)),
    set: (tokens) => db.run('UPDATE tokens SET token=:token WHERE id=1', {
      ':token': JSON.stringify(tokens),
    }),
  };

  const storage = {
    events: generateQB('events'),
    records: generateQB('records'),
    tokens,
  };

  server.decorate('storage', storage);

  return db;
};

const prepareDownloadTask = (server) => {
  const itemsInProcessing = new Set();

  return () => server.storage.records
    .read({ loadFromZoomState: loadStateEnum.ready })
    .then((items) => {
      const loadPromises = items.map((item) => {
        if (itemsInProcessing.has(item.id)) {
          return Promise.resolve();
        }
        itemsInProcessing.add(item.id);

        return Promise.resolve()
        // return downloadZoomFile({
        //   filepath: item.data.meta.filepath,
        //   url: item.data.download_url,
        //   token: item.data.download_token,
        // })
          .catch((err) => {
            console.error(err);
            item.loadFromZoomError = err.message;
            item.loadFromZoomState = loadStateEnum.failed;
          })
          .then(() => {
            if (item.loadFromZoomState !== loadStateEnum.failed) {
              item.loadFromZoomState = loadStateEnum.success;
            }
            return server.storage.records.update(item);
          });
      });

      return Promise.all(loadPromises);
    });
};

const prepareYoutubeTask = (server) => {
  const itemsInProcessing = new Set();
  let oauthClientInitialized = false;
  let youtubeService = null;

  return () => {
    if (!oauthClientInitialized) {
      return server.storage.tokens.get()
        .then((tokens) => {
          const isEmpty = Object.keys(tokens).length === 0;
          if (!isEmpty) {
            server.oauthClient.setCredentials(tokens);

            youtubeService = google.youtube({
              version: 'v3',
              auth: server.oauthClient,
            });

            oauthClientInitialized = true;
          }
        });
    }

    return server.storage.records
      .read({
        loadFromZoomState: loadStateEnum.success,
        loadToYoutubeState: loadStateEnum.ready,
      })
      .then((items) => {
        const loadPromises = items.map((item) => {
          return Promise.resolve();

          const data = {
            "id": "",
            "meeting_id": "",
            "recording_start": "2022-09-02T13:34:04Z",
            "recording_end": "2022-09-02T14:59:54Z",
            "file_type": "MP4",
            "file_extension": "MP4",
            "file_size": 270195276,
            "play_url": "",
            "download_url": "",
            "status": "completed",
            "recording_type": "shared_screen_with_speaker_view",
            "download_token": "",
            "meta": {
              "isHexletTopic": true,
              "isCollegeTopic": false,
              "date": "02.09.2022",
              "topicName": "Тема от 02.09.2022;Автор",
              "topicAuthor": "Автор",
              "topicPotok": "potok-46",
              "filename": "Тема_от_02.09.2022;Автор;2-0",
              "filepath": "/home/melodyn/projects/work/zoom-youtube-uploader/videos/Тема_от_02.09.2022;Автор;2-0.mp4",
              "youtubeDescription": "* Полное название: Тема\n* Дата: 02.09.2022\n* Автор: Автор\n* Поток: potok-46",
              "youtubeName": "Тема от 02.09.2022;Автор",
              "youtubePlaylist": "potok-46",
              "youtubeUrl": "",
              "zoomAuthorId": "mjD9HGTbT2OV0Mxq-M_o1w"
            }
          };

          // if (itemsInProcessing.has(item.id)) {
          //   return Promise.resolve();
          // }
          // itemsInProcessing.add(item.id);
          //
          // return Promise.resolve()
          //   .catch((err) => {
          //     console.error(err);
          //     item.loadToYoutubeError = err.message;
          //     item.loadToYoutubeState = loadStateEnum.failed;
          //   })
          //   .then(() => {
          //     if (item.loadToYoutubeState !== loadStateEnum.failed) {
          //       item.loadToYoutubeState = loadStateEnum.success;
          //     }
          //     return server.storage.records.update(item);
          //   });
        });

        return Promise.all(loadPromises);
      });
  }
};

const initTasks = (server) => [
  prepareDownloadTask(server),
  prepareYoutubeTask(server),
].map((task) => new CronService(
  task,
  ms(server.config.CRON_PERIOD),
  ms(server.config.CRON_DELAY),
));

export const app = async (envName) => {
  process.on('unhandledRejection', (err) => {
    console.error(err);
    process.exit(1);
  });

  const config = await configValidator(envName);

  const server = initServer(config);

  const db = await initDatabase(server);
  const cronJobs = initTasks(server);

  const stop = async () => {
    server.log.info('Stop app', config);
    server.log.info('  Stop cron');
    await Promise.all(cronJobs.map((cronJob) => cronJob.stop()));
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
  await Promise.all(cronJobs.map((cronJob) => cronJob.start()));

  return {
    server,
    config,
    stop,
  };
};
