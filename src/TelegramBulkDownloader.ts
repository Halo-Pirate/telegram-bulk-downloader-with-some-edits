import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import Byteroo, { Container } from 'byteroo';
import { Entity } from 'telegram/define';
import extractDisplayName from './helpers/extractDisplayName';
import ask from './helpers/ask';
import JsonSerializer from './helpers/JsonSerializer';
import checkbox from '@inquirer/checkbox';
import getInputFilter from './helpers/getInputFilter';
import getFilenameExtension from './helpers/getFilenameExtension';
import getMessageDate from './helpers/getMessageDate';
import MediaType from './types/MediaType';
import { LogLevel } from 'telegram/extensions/Logger';
import cliProgress from 'cli-progress';

class TelegramBulkDownloader {
  private storage: Byteroo;
  private credentials: Container;
  private state: Container;
  isDownloading: boolean;
  private SIGINT: boolean;
  private client?: TelegramClient;
  constructor() {
    this.storage = new Byteroo({
      name: 'TelegramBulkDownloader',
      autocommit: true,
    });
    this.credentials = this.storage.getContainerSync(
      'credentials'
    ) as Container;
    this.state = this.storage.getContainerSync('state') as Container;
    this.isDownloading = false;
    this.SIGINT = false;
  }

  private async newDownload() {
    if (!this.client) throw new Error('TelegramClient undefined');
    const query = await inquirer.prompt([
      {
        name: 'id',
        message: 'Please enter username or chat id of target: ',
      },
    ]);

    try {
      const res = await this.client.getEntity(query.id);
      const { metadata } = await inquirer.prompt([
        {
          name: 'metadata',
          message: 'Do you want to include metadata.json? (Recommended: no)',
          type: 'confirm',
        },
      ]);
      let mediaTypes: MediaType[] = [];
      while (mediaTypes.length <= 0) {
        mediaTypes = await checkbox({
          message: 'Select media types to download',
          choices: [
            { name: 'Pictures', value: 'InputMessagesFilterPhotos' },
            { name: 'Videos', value: 'InputMessagesFilterVideo' },
            { name: 'Documents', value: 'InputMessagesFilterDocument' },
            { name: 'Music', value: 'InputMessagesFilterMusic' },
            { name: 'Voice messages', value: 'InputMessagesFilterVoice' },
            { name: 'GIFs', value: 'InputMessagesFilterGif' },
          ],
        });
      }
      const outPath = await ask('Enter the folder path for file storage: ');
      this.state.set(res.id.toString(), {
        displayName: extractDisplayName(res),
        entityJson: res.toJSON(),
        outPath: path.resolve(outPath),
        metadata,
        mediaTypes: mediaTypes.map((e) => ({ type: e, offset: 0 })),
        originalId: query.id
      });
      await this.download(res);
    } catch (err) {
      console.error('Failed to retrieve chat', err);
      this.main();
    }
  }

  private async download(entity: Entity) {
    if (!this.client) throw new Error('TelegramClient undefined');
    const id = entity.id.toString();

    for (const mediaType of this.state.get(id).mediaTypes) {
      await this.downloadMediaType(entity, mediaType.type);
    }

    this.state.remove(id);
    await this.state.commit();
    process.exit(0);
  }

  private async downloadMediaType(entity: Entity, mediaType: MediaType) {
    if (!this.client) throw new Error('TelegramClient undefined');
    this.isDownloading = true;
    const id = entity.id.toString();
    const latestMessage = await this.client.getMessages(entity, { limit: 1 });
    this.state.set(id, { ...this.state.get(id), limit: latestMessage[0].id });

    const metadataOption = this.state.get(id).metadata;
    let jsonSerializer;
    if (metadataOption) {
      jsonSerializer = new JsonSerializer(
        path.join(this.state.get(id).outPath, 'metadata.json')
      );
    }

    // Collect message IDs of files that already exist in the output folder
    // (matches both "<id>.ext" and "<date>_<id>.ext", in any subfolder)
    const existingIds = new Set<number>();
    const scanExisting = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          scanExisting(path.join(dir, entry.name));
          continue;
        }
        const match = entry.name.match(/(?:^|_)(\d+)\.[^.]+$/);
        if (match) existingIds.add(Number(match[1]));
      }
    };
    scanExisting(this.state.get(id).outPath);

    while (true) {
      let offset = this.state
        .get(id)
        .mediaTypes.find((e: any) => e.type === mediaType).offset;

      const messages = await this.client.getMessages(entity, {
        limit: 1000,
        offsetId: offset,
        reverse: true,
        filter: getInputFilter(mediaType),
      });

      const mediaMessages = messages;

      const downloadDir = this.state.get(id).outPath;
      if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
      }

      let msgId = offset;
      let skipped = 0;
      for (const msg of mediaMessages) {
        if (existingIds.has(msg.id)) {
          skipped++;
          msgId = msg.id;
          if (this.SIGINT) break;
          continue;
        }
        const bar = new cliProgress.SingleBar(
          {
            format: `${msg.id}.${getFilenameExtension(
              msg
            )} {bar} {percentage}% | ETA: {eta}s`,
          },
          cliProgress.Presets.legacy
        );
        bar.start(100, 0);
        try {
          // Retry transient errors (e.g. -503 Timeout, flood waits, network drops)
          const MAX_ATTEMPTS = 6;
          let buffer: any;
          let current: any = msg;
          for (let attempt = 1; ; attempt++) {
            try {
              buffer = await this.client.downloadMedia(current, {
                progressCallback: (downloaded, total) => {
                  if (this.SIGINT)
                    throw new Error(`Aborting download, SIGINT=true`);
                  const ratio = Number(downloaded) / Number(total);
                  const progress = Math.round(Number(ratio) * 100);
                  bar.update(progress);
                },
              });
              break;
            } catch (err: any) {
              if (this.SIGINT || attempt >= MAX_ATTEMPTS) throw err;
              bar.stop();
              if (err?.errorMessage === 'FILE_REFERENCE_EXPIRED') {
                // The file reference in the fetched message went stale:
                // fetch the message again to get a fresh one, then retry
                console.warn(
                  `\n${msg.id}: file reference expired, refreshing message...`
                );
                const fresh = await this.client.getMessages(entity, {
                  ids: msg.id,
                });
                if (fresh[0]) current = fresh[0];
              } else {
                const floodSeconds =
                  typeof err?.seconds === 'number' ? err.seconds : 0;
                const waitMs = Math.max(floodSeconds * 1000, attempt * 3000);
                console.warn(
                  `\n${msg.id}: ${err?.errorMessage ?? err?.message ?? err}. ` +
                    `Retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(
                      waitMs / 1000
                    )}s...`
                );
                await new Promise((resolve) => setTimeout(resolve, waitMs));
              }
              bar.start(100, 0);
            }
          }
          bar.update(100);
          bar.stop();
          const filePath = path.join(
            downloadDir,
            `${msg.id}.${getFilenameExtension(msg)}`
          );
          fs.writeFileSync(filePath, buffer as any);

          // Keep the original file name, but set the file's date to the
          // date the media was originally created/uploaded on Telegram
          const date = getMessageDate(msg);
          fs.utimesSync(filePath, date, date);

          existingIds.add(msg.id);
          msgId = msg.id;
        } catch (err) {
          bar.stop();
          console.warn(err);
          if (!this.SIGINT) {
            console.warn(`Failed to download ${msg.id}, giving up on this file`);
            fs.appendFileSync(path.join(downloadDir, 'failed.txt'), `${msg.id}\n`);
          }
        }
        if (jsonSerializer) await jsonSerializer.append(msg);
        if (this.SIGINT) break;
      }

      if (skipped > 0)
        console.log(`Skipped ${skipped} already downloaded file(s)`);

      offset = mediaMessages.length <= 0 ? offset + 999 : msgId;

      this.state.set(id, {
        ...this.state.get(id),
        mediaTypes: this.state.get(id).mediaTypes.map((e: any) => {
          if (e.type === mediaType)
            return {
              ...e,
              offset,
            };
          return e;
        }),
      });

      if (this.SIGINT) {
        console.log(`Exiting, SIGINT=${this.SIGINT}`);
        await this.client.disconnect();
        await this.client.destroy();
        await this.state.commit();
        process.exit(0);
      }
      if (offset >= this.state.get(id).limit) {
        console.log(`Exiting, SIGINT=${this.SIGINT}`);
        this.state.set(id, {
          ...this.state.get(id),
          mediaTypes: this.state
            .get(id)
            .mediaTypes.filter((e: any) => e.type !== mediaType),
        });
        break;
      }
    }
  }

  private async resume() {
    if (!this.client) throw new Error('TelegramClient undefined');
    const res = await inquirer.prompt({
      name: 'resume',
      type: 'list',
      message: 'Choose a chat',
      choices: [
        ...this.state
          .list()
          .map((e) => ({ name: this.state.get(e).displayName || e, value: e })),
        { name: 'Back', value: 'backbutton' },
      ],
    });

    if (res.resume === 'backbutton') {
      return this.main();
    }

    const entityRes = await this.client.getEntity(
      this.state.get(res.resume).entityJson.username ||
        this.state.get(res.resume).originalId
    );
    this.download(entityRes);
  }

  async main() {
    let API_ID = this.credentials.get('API_ID');
    if (!API_ID) {
      API_ID = await ask('Please provide your API_ID: ');
      this.credentials.set('API_ID', API_ID);
    }

    let API_HASH = this.credentials.get('API_HASH');
    if (!API_HASH) {
      API_HASH = await ask('Please provide your API_HASH: ', {
        type: 'password',
      });
      this.credentials.set('API_HASH', API_HASH);
    }

    if (!this.client) {
      this.client = new TelegramClient(
        new StringSession(this.credentials.get('session')),
        parseInt(API_ID),
        API_HASH,
        {}
      );
      this.client.setLogLevel(LogLevel.NONE);
    }

    if (this.client.disconnected) {
      await this.client.start({
        phoneNumber: ask.bind(undefined, 'Please enter your phone number: '),
        password: ask.bind(undefined, 'Please enter your password: ', {
          type: 'password',
        }),
        phoneCode: ask.bind(undefined, 'Please enter the code you received: ', {
          type: 'password',
        }),
        onError: (err) => console.log(err),
      });

      this.credentials.set(
        'session',
        await (this.client as any).session.save()
      );
    }

    const menu = await inquirer.prompt({
      name: 'option',
      type: 'list',
      message: 'Choose an option',
      choices: [
        { name: 'Start new download', value: 'new_download' },
        { name: 'Resume active download', value: 'resume' },
        { name: 'Exit', value: 'exit' },
      ],
    });

    switch (menu.option) {
      case 'exit':
        process.exit(0);
      case 'new_download':
        this.newDownload();
        break;
      case 'resume':
        this.resume();
        break;
    }
  }

  run() {
    this.main();

    process.on('SIGINT', () => {
      console.log('Caught interrupt signal');
      if (!this.isDownloading) process.exit(0);
      this.SIGINT = true;
    });
  }

  getStoragePath() {
    return this.storage.path;
  }
}

export default TelegramBulkDownloader;
