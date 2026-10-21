/**
 * What a failed Slack call means for the call that got it.
 *
 * @slack/web-api reports a refusal from Slack's Web API as "An API error
 * occurred: <code>", which names Slack's code and nothing more: not whether
 * anything happened, which value the code is about, or what to do instead.
 * The explanation is appended after the error's own text, so its words stay
 * as they were. It says what didn't happen, names the value the call was
 * given, and points to the tool that shows real values, or says that only
 * whoever runs this host, or the workspace's admins, can change the answer.
 *
 * Three kinds of error are read, each by the client's own code: Slack's
 * refusals (`slack_webapi_platform_error`, whose `data` is Slack's answer,
 * with the code in `data.error`), a rate limit (`slack_webapi_rate_limited_error`,
 * with Slack's Retry-After as `retryAfter`), and a failure in transit
 * (`slack_webapi_request_error`, or `slack_webapi_http_error` with the HTTP
 * status), which leaves a write's outcome unknown, unless the connection
 * couldn't be made at all, which Node's code on the request error's
 * `original` tells. Six more are this server's own: a request its call's
 * deadline left no time to send (OutOfCallTime), fetch_attachment's download
 * running past its timeout, a listing the token's scopes leave no type to ask
 * for (NoReadableConversations), a failed post of an upload's bytes to Slack's
 * upload server (UploadBytesFailed), an upload whose last step named no file
 * (UploadNotConfirmed), and a post whose answer named no message
 * (PostNotConfirmed). Each refusal code here is one Slack's
 * reference documents for a method these tools call. A refusal whose code
 * isn't in Slack's form, as the client reads a body such as an HTML page, is
 * read as an answer that shows nothing about what Slack did, and so is a
 * TypeError from a write, which the client throws after a 200 it can't read
 * (cannotHaveLanded). Other errors, and codes not listed, pass through
 * unchanged, except that a read's failure still says that no messages were
 * returned.
 */
import { ErrorCode } from '@slack/web-api';
import { connectionNeverMade, reactionName } from './content.js';
import { NOTHING_RETURNED, PARENT_IDS, TS_FORM } from './history-read.js';
import {
  CALL_SECONDS,
  NoReadableConversations,
  OutOfCallTime,
  PostNotConfirmed,
  SLACK_CLIENT_OPTIONS,
  UploadBytesFailed,
  UploadNotConfirmed,
  failedRequest,
  retryAfterSeconds,
  slackRefusal,
} from './slack-adapter.js';

/** The call an error came from: a tool's name, or `channels/publish` for the
 *  host's publish, and the arguments it names Slack's objects by. */
export interface SlackCall {
  tool: string;
  args: Record<string, unknown>;
}

/** What didn't happen, by the call that failed. */
const NOT_DONE: Record<string, string> = {
  send_message: 'Nothing was posted',
  reply_message: 'Nothing was posted',
  'channels/publish': 'Nothing was posted',
  send_dm: 'Nothing was sent',
  upload_file: 'Nothing was uploaded',
  edit_message: "The message wasn't changed",
  delete_message: 'Nothing was deleted',
  add_reaction: 'No reaction was added',
  // A read can fail after its first pages, so its lead is what the caller
  // didn't get.
  fetch_history: NOTHING_RETURNED,
  fetch_thread: NOTHING_RETURNED,
  fetch_attachment: 'Nothing was fetched',
  list_channels: 'Nothing was listed',
  find_user: 'No users were listed',
  refresh_channels: 'Nothing was announced to the host',
};

const POSTS = new Set(['send_message', 'reply_message', 'channels/publish', 'send_dm', 'upload_file']);
/** The requests a write tool makes before its write: the conversation check
 *  under SLACK_DISABLE_DMS, send_dm's opening of the DM, and an upload's first
 *  step, which only gives it somewhere to send the file. A failure of one of
 *  these wrote nothing. Any other request a write tool makes reads as its own
 *  write, so a method missing here costs only a check before trying again,
 *  where one missing from a list of writes would say nothing was written when
 *  something may have been. */
const BEFORE_WRITE = new Set(['conversations.info', 'conversations.open', 'files.getUploadURLExternal']);
const WRITES = new Set([...POSTS, 'edit_message', 'delete_message', 'add_reaction']);
/** Tools whose listing pages through Slack inside the call, from the first
 *  page each time, so in a workspace too large to list within Slack's rate
 *  limit, calling again stops near the same page. */
const LISTINGS = new Set(['list_channels', 'find_user', 'refresh_channels']);

const RECALLED = 'The id may be mistyped or remembered rather than copied';
const MESSAGE_IDS =
  "Copy the message's id= from where it arrived, or take it from fetch_history (fetch_thread for a thread's replies)";

/** Slack's answers that the message or thread a call named isn't one. */
const THREAD_REFUSALS = new Set(['thread_not_found', 'message_not_found', 'bad_timestamp']);
/** The read tools, which return nothing when they fail. */
const READS = new Set(['fetch_history', 'fetch_thread']);
/** What each of a workspace's settings that refuse an upload allows, as
 *  Slack's pages for files.getUploadURLExternal and
 *  files.completeUploadExternal describe it. */
const UPLOAD_SETTINGS: Record<string, string> = {
  file_uploads_disabled: "don't allow file uploads",
  file_uploads_except_images_disabled: 'allow only image uploads',
  file_type_not_allowed: "don't allow this type of file",
  file_upload_size_restricted: 'restrict uploads of large files',
};
/** What may still go under a setting, where the setting says what may.
 *  file_type_not_allowed gets nothing, so the text doesn't hint at a way round
 *  the workspace's rule. */
const UPLOAD_SETTING_REMEDIES: Record<string, string> = {
  file_uploads_except_images_disabled: ' An image file may go.',
  file_upload_size_restricted: ' A smaller file may go.',
};

export function explainSlackError(err: unknown, call: SlackCall): string {
  const carried = (err as { message?: unknown } | null)?.message;
  const text = typeof carried === 'string' ? carried : String(err);
  // A read that fails returns nothing, so a failure of one that nothing below
  // explains still says so, unless its own text opens with it, as the read's
  // own refusals do. A write's may have written, so it passes through.
  const unexplained = READS.has(call.tool) && !text.startsWith(NOTHING_RETURNED) ? `${NOTHING_RETURNED}.` : undefined;
  const why = explanation(err, call) ?? unexplained;
  return why ? `${text}\n\n${why}` : text;
}

function explanation(err: unknown, call: SlackCall): string | undefined {
  const e = err as {
    code?: unknown;
    retryAfter?: number;
    statusCode?: unknown;
    original?: { code?: unknown };
    data?: { needed?: unknown };
  } | null;
  // A value is named exactly as the call was given it, untrimmed. A blank one
  // counts as none given: the text falls back to general wording, and a blank
  // message or thread id passes through as one from a call that named none.
  const given = (key: string): string | undefined => {
    const v = call.args[key];
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  // An upload's file is shared only at its last step, so a failure there, or
  // of the bytes before it, which may have reached Slack's upload server,
  // leads with what is true of the file by then.
  const sharing = call.tool === 'upload_file' &&
    (failedRequest(err) === 'files.completeUploadExternal' || err instanceof UploadBytesFailed);
  const lead = sharing ? 'Nothing was shared' : NOT_DONE[call.tool] ?? 'Nothing was done';
  const channel = given('channelId');
  const conversation = channel ? `conversation ${channel}` : 'the conversation';
  // The message a call names: messageId, or fetch_thread's threadTs.
  const ts = given('messageId') ?? given('threadTs');
  const theMessage = ts ? `message ${ts}` : 'the message';
  // The thread a call reads or posts into: fetch_thread's threadTs, the parent
  // reply_message or upload_file replies under (its messageId), or, for channels/publish, the
  // thread its publish was sent to, which handleRequest passes as threadTs.
  const thread = call.tool === 'reply_message' || call.tool === 'upload_file' ? given('messageId') : given('threadTs');
  const userId = given('userId');
  const theUser = userId ? `user ${userId}` : 'the user given';
  const isWrite = WRITES.has(call.tool);
  // A write's outcome is unknown unless the request that failed is one known
  // to come before the write. An error no request of the client's threw keeps
  // the tool's reading, since then which request failed can't be told.
  const failed = failedRequest(err);
  const mayHaveWritten = isWrite && (failed === undefined || !BEFORE_WRITE.has(failed));
  /** For a listing tool: a new call starts over, so a listing too large for
   *  `limit` stops near the same place each time. */
  const startsOver = (limit: string) => LISTINGS.has(call.tool)
    ? ` A new call starts the listing over from the first page, so if the workspace is too large to list within ${limit}, ` +
      'calling again stops near the same place.'
    : '';
  /** Slack's rate limit, with the seconds it asks to wait when it gave them. */
  const rateLimited = (seconds: number | undefined): string =>
    seconds === undefined
      ? `${lead}: Slack is rate-limiting this kind of call for the workspace. Try again shortly.${startsOver("Slack's limit")}`
      : `${lead}: Slack is rate-limiting this kind of call for the workspace, and asks to wait ${seconds} ` +
        `second${seconds === 1 ? '' : 's'} before trying again.${startsOver("Slack's limit")}`;
  const invite =
    "Someone in that conversation has to invite the bot (in Slack, /invite and the bot's name); until then, " +
    "calling again gets the same answer. list_channels shows the conversations it's in.";
  /** A write whose outcome is unknown, and how to check it before trying again. */
  const unknown = (cause: string, note = ''): string => {
    if (POSTS.has(call.tool)) {
      // fetch_history leaves out a reply that wasn't also sent to the
      // channel, so a reply is looked for in its thread.
      const where = !channel
        ? "the DM's history (list_channels shows its id, and fetch_history its messages)"
        : thread
          ? `fetch_thread for the thread under message ${thread} in ${conversation}`
          : `fetch_history for ${conversation}`;
      if (call.tool === 'upload_file') {
        return (
          `${cause}, so whether the file was shared is unknown${note}. Check ${where} before uploading again, so ` +
          "it isn't shared twice."
        );
      }
      return (
        `${cause}, so whether the message was posted is unknown${note}. Check ${where} before posting again, so ` +
        "it isn't posted twice."
      );
    }
    // fetch_history leaves out a reply that wasn't also sent to the channel,
    // and only the agent knows whether the message it names is a thread reply.
    const where = "if it's in the channel itself, and fetch_thread does, with its thread's id, if it's a thread reply";
    if (call.tool === 'edit_message') {
      return `${cause}, so whether the edit took is unknown${note}. fetch_history shows ${theMessage} as it is now ${where}.`;
    }
    if (call.tool === 'delete_message') {
      return (
        `${cause}, so whether ${theMessage} was deleted is unknown${note}. fetch_history shows whether it's still ` +
        `there ${where}. Deleting it again is safe: once it's gone, Slack answers message_not_found.`
      );
    }
    return (
      `${cause}, so whether the reaction was added is unknown${note}. Adding it again is safe: if it's there, ` +
      'add_reaction says so and changes nothing.'
    );
  };

  if (err instanceof UploadNotConfirmed) {
    // Its ID came from the first step, so a rollback deletes it either way.
    return unknown("Slack's answer to the upload's last step named no file");
  }
  if (err instanceof PostNotConfirmed) {
    // No ID, so a rollback can only say it may remain.
    return unknown("Slack's answer to the post named no message");
  }
  if (err instanceof UploadBytesFailed) {
    const seconds = SLACK_CLIENT_OPTIONS.timeout / 1000;
    const unshared = "Slack shares a file only at the upload's last step, which wasn't sent";
    if (err.why === 'TimeoutError') {
      // The timeout covers the whole post: the bytes, the answer and its body.
      // The bytes may have reached the server, so this says only that the
      // post didn't finish.
      return (
        `${lead}: the post of the file's bytes to Slack's upload server didn't finish within ${seconds} seconds. ` +
        `${unshared}, so calling again is safe. If it keeps timing out, Slack's upload server or this server's ` +
        `connection to it is too slow for this file within ${seconds} seconds: a smaller file may go through, ` +
        'and whoever runs this host can look into the connection.'
      );
    }
    if (err.why === 'transit') {
      return (
        `${lead}: the connection to Slack's upload server failed. ${unshared}. Try again shortly. If it keeps ` +
        "failing, whoever runs this host has to check its connection to Slack's upload server."
      );
    }
    return `${lead}: Slack's upload server answered the file's bytes with HTTP ${err.why}. ${unshared}. Try again shortly.`;
  }
  if (err instanceof OutOfCallTime) {
    // Not sent: a call's request goes out only if its timeout fits
    // (assertRequestFits).
    return (
      `${lead}: this server gives each call ${CALL_SECONDS} seconds from when it reaches this server, and this one ` +
      `had used ${err.usedSeconds} of them, waiting behind earlier calls or on its own earlier requests, so too ` +
      `few were left to send this request to Slack. It wasn't sent, so calling again is safe.` +
      startsOver(`a call's ${CALL_SECONDS} seconds`)
    );
  }
  if (err instanceof NoReadableConversations) {
    // Not sent: Slack refuses a listing for a type whose read scope the token
    // lacks, and the scopes Slack last reported read none of them. Its message,
    // which the answer opens with, names the read scopes.
    return (
      `${lead}: Slack lists each kind of conversation only for a token with that kind's read scope. Calling ` +
      "again won't change that: whoever runs this host has to add one of those scopes to the app's bot token " +
      'scopes and reinstall the app to the workspace.'
    );
  }
  if (call.tool === 'fetch_attachment' && (err as { name?: unknown } | null)?.name === 'TimeoutError') {
    // The download's own timeout, the client's, set where fetch_attachment
    // starts it: AbortSignal.timeout rejects with a TimeoutError.
    const seconds = SLACK_CLIENT_OPTIONS.timeout / 1000;
    return (
      `${lead}: Slack's file host didn't finish sending the file within ${seconds} seconds. Fetching changes ` +
      `nothing, so calling again is safe. If it keeps timing out, Slack's file host or this server's ` +
      `connection to it is too slow to send this file within ${seconds} seconds.`
    );
  }
  if (e?.code === ErrorCode.RateLimitedError) {
    // The client throws this only with Slack's Retry-After, in seconds, which
    // are given as for a ratelimited refusal (retryAfterSeconds).
    return rateLimited(retryAfterSeconds(err));
  }
  if (e?.code === ErrorCode.RequestError && connectionNeverMade(e.original?.code)) {
    return (
      `${lead}: Slack couldn't be reached. Try again shortly. If it keeps failing, whoever runs this host has ` +
      'to check its connection to Slack.'
    );
  }
  if (e?.code === ErrorCode.RequestError || e?.code === ErrorCode.HTTPError) {
    const cause = e.code === ErrorCode.HTTPError
      ? `Slack answered with HTTP ${e.statusCode}`
      : `Slack went ${SLACK_CLIENT_OPTIONS.timeout / 1000} seconds without answering, or the connection to it failed`;
    return mayHaveWritten ? unknown(cause) : `${lead}: ${cause}. Try again shortly.`;
  }
  if (err instanceof TypeError && mayHaveWritten) {
    // The client throws one after a 200 whose answer isn't in Slack's shape,
    // so cannotHaveLanded keeps such a write possibly done.
    return unknown("Slack's answer, if one came, couldn't be read");
  }
  const code = slackRefusal(err);
  // An answer the client reads as a refusal but whose code isn't in Slack's
  // form, such as an HTML page, shows nothing about what Slack did.
  if (code === undefined && e?.code === ErrorCode.PlatformError) {
    const cause = "Slack answered in a form this server can't read";
    return mayHaveWritten
      ? unknown(cause)
      : `${lead}: ${cause}. Try again shortly. If it keeps failing, whoever runs this host has to check its ` +
          'connection to Slack.';
  }
  if (code === undefined) return undefined;
  const messageIds = call.tool === 'reply_message' || call.tool === 'fetch_thread' || call.tool === 'upload_file' ? PARENT_IDS : MESSAGE_IDS;

  // channels/publish names no message or thread itself: this server replies in
  // the thread of the last message from the conversation that the host took
  // (set in taken()), as recorded before the post. Without one, Slack
  // refused nothing a call named, so there's nothing true to add. Another
  // publish goes to the same thread until the host takes a new message from
  // the conversation, or a new connection clears the record (serve()), so the
  // text says where one would go now rather than how long that lasts.
  if (call.tool === 'channels/publish' && THREAD_REFUSALS.has(code)) {
    return thread
      ? `${lead}: this server replies in the thread of the last message from a conversation that reached you. ` +
          `Here that was the thread under message ${thread} in ${conversation}, and Slack refused it. ` +
          `Another publish to ${conversation} now would go to the same thread. ` +
          'send_message posts in the conversation itself, and reply_message under a message you choose.'
      : undefined;
  }

  switch (code) {
    case 'channel_not_found':
      return (
        `${lead}: Slack doesn't know ${conversation}, or this bot can't see it. ${RECALLED}, or it's a ` +
        "private conversation this bot isn't in. list_channels shows the conversations this bot can use, " +
        'with their ids.'
      );
    case 'invalid_channel_id':
      return (
        `${lead}: ${channel ?? 'the conversation given'} isn't a Slack conversation id. ${RECALLED}. ` +
        'list_channels shows the conversations this bot can use, with their ids.'
      );
    case 'not_in_channel':
      if (call.tool === 'upload_file') {
        return `${lead}: this bot isn't a member of ${conversation}, so Slack didn't let it share the file there. ${invite}`;
      }
      return POSTS.has(call.tool)
        ? `${lead}: this bot isn't a member of ${conversation}, so Slack didn't let it post there. ${invite} ` +
            'For a public channel, whoever runs this host can instead grant the Slack app the chat:write.public ' +
            "scope, which lets it post in channels it hasn't joined."
        : `${lead}: this bot isn't a member of ${conversation}, so Slack didn't let it ` +
            `${isWrite ? 'do that' : 'read'} there. ${invite}`;
    case 'is_archived':
      return (
        `${lead}: ${conversation} is archived, so nothing can be posted or changed there. Calling again ` +
        "won't change that unless someone in the workspace unarchives it."
      );
    case 'is_inactive':
      return (
        `${lead}: ${conversation} is archived, frozen or deleted, so nothing can be changed there, and calling ` +
        "again won't change that."
      );
    // A call that named no message or thread can't have named a wrong one.
    case 'message_not_found':
      if (!ts) return undefined;
      return (
        `${lead}: Slack has no message ${ts} in ${conversation}. ${RECALLED}, or the message was deleted or is ` +
        `in another conversation. ${messageIds}, with the conversation it's in.`
      );
    case 'bad_timestamp':
      if (!ts) return undefined;
      return `${lead}: ${ts} isn't a message id, ${TS_FORM}. ${messageIds}.`;
    case 'thread_not_found':
      if (!thread) return undefined;
      return `${lead}: Slack has no thread under message ${thread} in ${conversation}. ${RECALLED}. ${PARENT_IDS}.`;
    case 'invalid_ts_latest':
    case 'invalid_ts_oldest': {
      const bound = code === 'invalid_ts_latest' ? 'latest' : 'oldest';
      const value = given(bound);
      return (
        `${lead}: ${bound}${value ? ` ${value}` : ''} isn't a message id, ${TS_FORM}. Take one from ` +
        "fetch_history's ids, or from a message's id=."
      );
    }
    case 'cant_update_message':
    case 'cant_delete_message':
      return (
        `${lead}: this bot can ${code === 'cant_update_message' ? 'edit' : 'delete'} only messages it posted, ` +
        `and ${theMessage} in ${conversation} isn't one of them. Calling again won't change that.`
      );
    case 'edit_window_closed':
      return (
        `${lead}: this workspace doesn't allow editing a message this old, and calling again won't change that. ` +
        'To correct it, post a new message, or use reply_message with its id to put the correction under it.'
      );
    case 'msg_too_long':
      return call.tool === 'edit_message'
        ? `${lead}: Slack takes at most 4,000 characters of text in an edit, and this text is longer. Shorten ` +
            'it, or edit in a shorter version and post the rest with reply_message.'
        : `${lead}: Slack refused the text as too long. Split it into shorter messages and send them in order.`;
    case 'invalid_name': {
      const emoji = given('emoji');
      // Slack judged the name add_reaction sent: the one given, with every colon
      // removed. A colon between other characters, as in a skin tone, means
      // the name Slack judged isn't one anyone chose.
      const sent = emoji === undefined ? undefined : reactionName(emoji);
      const inside = emoji !== undefined && /[^:\s]:+[^:\s]/.test(emoji);
      const named = sent === undefined
        ? 'by the name given'
        : sent === emoji
          ? `named "${emoji}"`
          : `named "${sent}", the name this server sent for "${emoji}"`;
      return (
        `${lead}: this workspace has no emoji ${named}.` +
        (inside
          ? " This server removes every colon from a name, so a name with a colon inside, such as a skin tone's, " +
            "can't be added here. Pass a name Slack's emoji picker shows, such as thumbsup, white_check_mark or eyes."
          : " Pass a name Slack's emoji picker shows, such as thumbsup, white_check_mark or eyes; a custom emoji " +
            'has to be added to the workspace first.')
      );
    }
    case 'restricted_action_thread_only_channel':
      return call.tool === 'upload_file'
        ? `${lead}: ${conversation} takes messages only as thread replies. Pass messageId, the id of the message ` +
          'whose thread the file goes in.'
        : `${lead}: ${conversation} takes messages only as thread replies. Use reply_message with the id of the ` +
          "message you're answering.";
    case 'restricted_action_non_threadable_channel':
      return call.tool === 'upload_file'
        ? `${lead}: ${conversation} doesn't take thread replies. Upload without messageId instead.`
        : `${lead}: ${conversation} doesn't take thread replies. Post with send_message instead.`;
    case 'restricted_action':
    case 'restricted_action_read_only_channel':
    case 'restricted_action_thread_locked':
    case 'thread_locked':
    case 'ekm_access_denied': {
      const detail =
        code === 'restricted_action'
          ? 'a workspace setting stops this bot from doing this'
          : code === 'restricted_action_read_only_channel'
            ? `${conversation} is read-only`
            : code === 'ekm_access_denied'
              ? "the workspace's admins have turned this off there"
              : 'the thread is locked';
      return (
        `${lead}: Slack refused it under the workspace's settings: ${detail}. Calling again won't change that; ` +
        "only the workspace's admins can."
      );
    }
    case 'missing_scope': {
      const needed = typeof e?.data?.needed === 'string' && e.data.needed ? e.data.needed : undefined;
      return (
        `${lead}: this bot's Slack app hasn't been granted the scope this call needs` +
        `${needed ? ` (Slack names ${needed})` : ''}, so Slack refused it. Calling again won't change that: ` +
        `whoever runs this host has to add ${needed ? 'it' : 'the scope'} to the app's bot token scopes and ` +
        'reinstall the app to the workspace.'
      );
    }
    case 'invalid_auth':
    case 'not_authed':
    case 'account_inactive':
    case 'token_revoked':
    case 'token_expired':
      return (
        `${lead}: Slack doesn't accept this server's bot token, so it refused the call. Every Slack tool here ` +
        "fails the same way until whoever runs this host fixes the token or the app's installation; calling " +
        "again won't help."
      );
    case 'request_timeout':
      // Slack: the POST data was either missing or truncated.
      return `${lead}: Slack didn't receive the whole request, so it didn't act on it. Try again shortly.`;
    case 'ratelimited':
      // A rate limit in the body of a 200, which the client never waits out,
      // with Slack's seconds when a Retry-After came with it.
      return rateLimited(retryAfterSeconds(err));
    case 'internal_error':
    case 'fatal_error':
    case 'service_unavailable':
    // files.completeUploadExternal's: "Failure occurred when attempting to
    // update the file."
    case 'file_update_failed':
      if (!mayHaveWritten) return `${lead}: Slack failed while handling the call. Try again shortly.`;
      return unknown(
        'Slack failed while handling the call',
        code === 'internal_error' || code === 'fatal_error' ? ' (Slack says part of a call can take effect before this error)' : '',
      );
    case 'file_not_found':
      // files.completeUploadExternal's: "Could not find the file from the
      // upload ticket."
      return call.tool === 'upload_file'
        ? `${lead}: Slack couldn't find the file this upload's first step set up. Calling again starts a new upload.`
        : undefined;
    // A workspace's refusals of an upload, which last until its admins change
    // them (R1-2). files.getUploadURLExternal documents all five, and
    // files.completeUploadExternal the two about file types.
    case 'file_uploads_disabled':
    case 'file_uploads_except_images_disabled':
    case 'file_type_not_allowed':
    case 'file_upload_size_restricted':
      return call.tool === 'upload_file'
        ? `${lead}: this workspace's settings ${UPLOAD_SETTINGS[code]} (${code}). Calling again won't change that; ` +
            `the workspace's admins can.${UPLOAD_SETTING_REMEDIES[code] ?? ''}`
        : undefined;
    case 'storage_limit_reached':
      return call.tool === 'upload_file'
        ? `${lead}: this workspace has reached its file storage limit (${code}). Calling again won't change that; ` +
            "the workspace's admins can."
        : undefined;
    case 'user_not_found':
      return (
        `${lead}: Slack has no user ${userId ?? 'by the id given'}. ${RECALLED}. find_user returns each ` +
        "person's userId."
      );
    case 'user_not_visible':
      return (
        `${lead}: this bot isn't allowed to see ${theUser}, so it can't open a DM with them. Calling again ` +
        "won't change that."
      );
  }
  return undefined;
}
