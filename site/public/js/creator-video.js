// Click-to-play for local creators' TikTok cards (components/CreatorVideos.astro).
//
// Nothing from TikTok loads until a reader presses play: the card is our own
// markup, with a plain "Watch on TikTok" link that works with this script off.
// Pressing play swaps in TikTok's embed player, and only then does the reader's
// browser contact TikTok. Served as a file, not inline, so the site's CSP can
// keep script-src 'self'; the CSP's frame-src allows the one player origin.
(() => {
	const ID = /^\d{15,20}$/;
	for (const button of document.querySelectorAll("button[data-tiktok-play]")) {
		button.hidden = false;
	}
	document.addEventListener("click", (event) => {
		const button =
			event.target instanceof Element
				? event.target.closest("button[data-tiktok-play]")
				: null;
		if (!button) return;
		const id = button.getAttribute("data-tiktok-play") ?? "";
		const stage = button
			.closest(".creator-video")
			?.querySelector(".creator-video__stage");
		if (!ID.test(id) || !stage) return;
		const frame = document.createElement("iframe");
		frame.src = `https://www.tiktok.com/player/v1/${id}?autoplay=1&rel=0&description=1&music_info=1`;
		frame.title = button.getAttribute("data-title") ?? "TikTok video";
		frame.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
		frame.allowFullscreen = true;
		frame.referrerPolicy = "strict-origin-when-cross-origin";
		frame.className = "creator-video__frame";
		stage.replaceChildren(frame);
		frame.focus();
	});
})();
