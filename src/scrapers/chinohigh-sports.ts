// Phase 4 Task 4.8 — Chino High School athletics (Home Campus).
// Endpoint, robots position and citation rule: see homecampus-sports.ts.
import { homeCampusScraper } from "./homecampus-sports.ts";

export default homeCampusScraper({
	key: "chinohigh-sports",
	name: "Chino High School Athletics (scores and schedules)",
	host: "www.chinohighathletics.com",
	schoolId: 103,
	label: "Chino High School",
});
