// The phone share shortcut's only command (deploy/README.md, "Phone share
// shortcut"). An SSH key restricted to this script sends whatever the share
// sheet handed it, and that text arrives in SSH_ORIGINAL_COMMAND as data: sshd
// runs this script no matter what was sent, and no shell ever reads the text.
//
// Sharing is the review: the operator picked the video while watching it, so
// it publishes at once (operator decision, 2026-11-13). Rejected or removed
// videos and removed creators stay dashboard decisions. Every outcome prints
// one line and exits 0, because the Shortcuts app shows stdout as the
// notification.
import { pathToFileURL } from "node:url";
import { openDb } from "../db/index.ts";
import { CreatorInputError, publishSharedPost } from "./store.ts";
import {
	type FetchLike,
	parseTikTokUrl,
	resolveShortLink,
	type TikTokVideoRef,
} from "./tiktok.ts";

const MAX_INPUT = 2000;

/**
 * TikTok's share sheet sends a sentence with the link in it, so take the first
 * URL in the text rather than expecting a bare link.
 */
export async function refFromShared(
	text: string,
	fetchImpl?: FetchLike,
): Promise<TikTokVideoRef | string> {
	const url = text.slice(0, MAX_INPUT).match(/https?:\/\/[^\s"'<>]+/)?.[0];
	if (!url) return "No link found in what was shared.";
	let parsed = parseTikTokUrl(url);
	if (parsed.kind === "short")
		parsed = await resolveShortLink(parsed.url, fetchImpl);
	if (parsed.kind === "video") return parsed.ref;
	return parsed.kind === "error"
		? parsed.reason
		: "That link did not lead to a video.";
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const shared =
		process.env.SSH_ORIGINAL_COMMAND ?? process.argv.slice(2).join(" ");
	const ref = await refFromShared(shared);
	if (typeof ref === "string") {
		console.log(ref);
	} else {
		try {
			// ponytail: fixed line. TikTok's oEmbed no longer returns the caption
			// and scraping the page breaks its terms; add a dashboard edit if a
			// post needs better words.
			console.log(
				publishSharedPost(openDb(), ref, `A video from @${ref.handle}.`),
			);
		} catch (err) {
			if (!(err instanceof CreatorInputError)) throw err;
			console.log(err.message);
		}
	}
}
