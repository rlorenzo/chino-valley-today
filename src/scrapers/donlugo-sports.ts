// Phase 4 Task 4.8 — Don Lugo High School athletics (Home Campus).
// Endpoint, robots position and citation rule: see homecampus-sports.ts.
import { homeCampusScraper } from "./homecampus-sports.ts";

export default homeCampusScraper({
	key: "donlugo-sports",
	name: "Don Lugo High School Athletics (scores and schedules)",
	host: "www.donlugosports.com",
	schoolId: 143,
	label: "Don Antonio Lugo High School",
});
