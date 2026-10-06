// Every test runs against a user library that does not exist, so what a person has saved in library/custom never changes a test's outcome.
// Tests of the user library itself set FEED_USER_LIBRARY to their own file.
import { tmpdir } from "os";
import { join } from "path";

process.env.FEED_USER_LIBRARY = join(tmpdir(), "feed-tests-no-user-library", String(process.pid), "materials.json");
