import { Api } from 'telegram';

// Returns the date the media was originally created/uploaded on Telegram.
// Order: media's own date -> original forward date -> date posted in this chat.
const getMessageDate = (msg: Api.Message): Date => {
  let seconds: number | undefined;

  if (
    msg.media?.className === 'MessageMediaPhoto' &&
    msg.media.photo?.className === 'Photo'
  ) {
    seconds = msg.media.photo.date;
  } else if (
    msg.media?.className === 'MessageMediaDocument' &&
    msg.media.document?.className === 'Document'
  ) {
    seconds = msg.media.document.date;
  }

  seconds = seconds ?? msg.fwdFrom?.date ?? msg.date;

  return new Date(seconds * 1000);
};

export default getMessageDate;
