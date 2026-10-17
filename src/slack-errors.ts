/**
 * What Slack's refusal means for the call that got it.
 *
 * @slack/web-api reports a refusal from Slack's Web API as "An API error
 * occurred: <code>", which names Slack's code and nothing more: not whether
 * anything happened, which value the code is about, or what to do instead.
 * The explanation is appended after the error's own text, so its words stay
 * as they were. It says what didn't happen, names the value the call was
 * given, and points to the tool that shows real values, or says that only
 * whoever runs this host, or the workspace's admins, can change the answer.
 *
 * Only Slack's refusals are read: the client's `slack_webapi_platform_error`,
 * whose `data` is Slack's answer, with the code in `data.error`. Each code
 * here is one Slack's reference documents for a method these tools call.
 * Other errors, and codes not listed, pass through unchanged.
 */
import { ErrorCode } from '@slack/web-api';
import { reactionName } from './content.js';

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
  fetch_history: 'Nothing was read',
  fetch_thread: 'Nothing was read',
  list_channels: 'Nothing was listed',
  find_user: 'No users were listed',
  refresh_channels: 'Nothing was announced to the host',
};

const POSTS = new Set(['send_message', 'reply_message', 'channels/publish', 'send_dm', 'upload_file']);
const WRITES = new Set([...POSTS, 'edit_message', 'delete_message', 'add_reaction']);

const RECALLED = 'The id may be mistyped or remembered rather than copied';
const MESSAGE_IDS =
  "Copy the message's id= from where it arrived, or take it from fetch_history (fetch_thread for a thread's replies)";
/** reply_message's messageId and fetch_thread's threadTs name a thread's parent. */
const PARENT_IDS =
  "Pass the thread's parent id: a reply's thread=, or the id of the message the replies are under, which " +
  'fetch_history shows';
const TS_FORM = 'which looks like 1718000000.000100';

/** Slack's answers that the message or thread a call named isn't one. */
const THREAD_REFUSALS = new Set(['thread_not_found', 'message_not_found', 'bad_timestamp']);

export function explainSlackError(err: unknown, call: SlackCall): string {
  const carried = (err as { message?: unknown } | null)?.message;
  const text = typeof carried === 'string' ? carried : String(err);
  const why = explanation(err, call);
  return why ? `${text}\n\n${why}` : text;
}

function explanation(err: unknown, call: SlackCall): string | undefined {
  const e = err as { code?: unknown; data?: { error?: unknown; needed?: unknown } } | null;
  if (e?.code !== ErrorCode.PlatformError || typeof e.data?.error !== 'string') return undefined;
  const code = e.data.error;
  // A value is named exactly as the call was given it, untrimmed. A blank one
  // counts as none given: the text falls back to general wording, and a blank
  // message or thread id passes through as one from a call that named none.
  const given = (key: string): string | undefined => {
    const v = call.args[key];
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  const lead = NOT_DONE[call.tool] ?? 'Nothing was done';
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
  const invite =
    "Someone in that conversation has to invite the bot (in Slack, /invite and the bot's name); until then, " +
    "calling again gets the same answer. list_channels shows the conversations it's in.";
  const messageIds = call.tool === 'reply_message' || call.tool === 'fetch_thread' ? PARENT_IDS : MESSAGE_IDS;

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
        return `${lead}: this bot isn't a member of ${conversation}, so Slack didn't let it upload there. ${invite}`;
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
      return (
        `${lead}: ${conversation} takes messages only as thread replies. Use reply_message with the id of the ` +
        "message you're answering."
      );
    case 'restricted_action_non_threadable_channel':
      return `${lead}: ${conversation} doesn't take thread replies. Post with send_message instead.`;
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
      const needed = typeof e.data.needed === 'string' && e.data.needed ? e.data.needed : undefined;
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
    case 'internal_error':
    case 'fatal_error':
    case 'service_unavailable': {
      if (!isWrite) return `${lead}: Slack failed while handling the call. Try again shortly.`;
      const partly = code === 'service_unavailable'
        ? ''
        : ' (Slack says part of a call can take effect before this error)';
      const failed = 'Slack failed while handling the call, so whether';
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
            `${failed} the file was uploaded is unknown${partly}. Check ${where} before uploading again, so it ` +
            "isn't uploaded twice."
          );
        }
        return (
          `${failed} the message was posted is unknown${partly}. Check ${where} before posting again, so it ` +
          "isn't posted twice."
        );
      }
      // fetch_history leaves out a reply that wasn't also sent to the channel,
      // and only the agent knows whether the message it names is a thread reply.
      const where = "if it's in the channel itself, and fetch_thread does, with its thread's id, if it's a thread reply";
      if (call.tool === 'edit_message') {
        return `${failed} the edit took is unknown${partly}. fetch_history shows ${theMessage} as it is now ${where}.`;
      }
      if (call.tool === 'delete_message') {
        return (
          `${failed} ${theMessage} was deleted is unknown${partly}. fetch_history shows whether it's still there ` +
          `${where}. Deleting it again is safe: once it's gone, Slack answers message_not_found.`
        );
      }
      return (
        `${failed} the reaction was added is unknown${partly}. Adding it again is safe: if it's there, Slack ` +
        'answers already_reacted.'
      );
    }
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
