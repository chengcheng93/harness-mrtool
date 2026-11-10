import assert from "node:assert/strict";
import test from "node:test";
import { loadMrBundle } from "../../src/app/load-mr-bundle.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import { appendSubmissionMarker } from "../../src/render/submission.ts";
test("response-only submissions are rejected clearly before legacy receipt lookup", async () => {
 let receiptReads=0;
 const description=appendSubmissionMarker("Created from API response.\n", {cliVersion:"0.1.10",issueIid:41,targetProjectPath:"group/project",sourceHeadSha:"b".repeat(40)});
 await assert.rejects(loadMrBundle({current:{iid:88,targetProjectId:"7",description},source:{gitlabOrigin:"https://gitlab.example.test",receiptLoader:{loadVerified:async()=>{receiptReads++;throw new Error("legacy receipt must not be loaded");}},bundleLoader:{}} as never}), error=>isToolError(error,"INPUT_ERROR")&&/submission|response/i.test(error.message));
 assert.equal(receiptReads,0);
});
