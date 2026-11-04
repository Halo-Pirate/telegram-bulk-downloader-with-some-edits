import { Api } from 'telegram';
import mime from 'mime-types';

const extractExtensionFromFilename = (filename: string) => {
  const split = filename.split('.');
  if (split.length <= 1) return false;
  return split[split.length - 1];
};

const getFilenameExtension = (msg: Api.Message): string => {
  switch (msg.media?.className) {
    case 'MessageMediaPhoto':
      return 'jpg';
    case 'MessageMediaDocument': {
      const doc = msg.media.document;
      if (doc?.className === 'Document') {
        const fromMime = mime.extension(doc.mimeType);
        if (typeof fromMime === 'string') return fromMime;

        const attribute = doc.attributes?.find(
          (e) => e.className === 'DocumentAttributeFilename'
        ) as Api.DocumentAttributeFilename | undefined;
        if (attribute) {
          const fromName = extractExtensionFromFilename(attribute.fileName);
          if (fromName) return fromName;
        }
      }
      return 'bin';
    }
    default:
      return 'bin';
  }
};

export default getFilenameExtension;
