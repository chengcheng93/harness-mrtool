import assert from "node:assert/strict";
import test from "node:test";
import { GitLabClient } from "../../src/gitlab/client.ts";
import { selectSubmissionMilestone } from "../../src/app/select-submission-milestone.ts";
import { FakeGitLab } from "../helpers/fake-gitlab.ts";
const path = (page: number) => "/api/v4/projects/group%2Fproject/milestones?include_ancestors=true&state=active&per_page=100&page=" + page;
const row = (id: unknown, due_date: unknown = "2026-11-12") => ({id,title:"Release",state:"active",due_date});
function fixture() { const fake = new FakeGitLab(); return { fake, client: new GitLabClient({origin:"https://gitlab.example.test",tokenProvider:async()=>"glpat-test",transport:fake}) }; }
test("reads all project and ancestor milestones before selecting page-two nearest", async () => {
 const {fake,client}=fixture();
 fake.enqueue("GET",path(1),{headers:{"x-next-page":"2"},body:[row(101,"2026-12-01"),row(102,null)]});
 fake.enqueue("GET",path(2),{headers:{"x-next-page":""},body:[row(12),row(101,"2026-12-01")]});
 const all=await client.listProjectMilestones("group/project");
 assert.deepEqual(all.map(m=>m.id),[101,102,12]);
 assert.equal(selectSubmissionMilestone(all,"2026-11-11").milestone?.id,12);
 assert.equal(fake.requests.length,2); assert.ok(fake.requests.every(r=>r.method==="GET"));
});
for (const [name,value] of Object.entries({zero:0,negative:-1,fraction:1.5,string:"1",unsafe:Number.MAX_SAFE_INTEGER+1,null:null,missing:undefined})) test("rejects malformed milestone ID "+name,async()=>{
 const {fake,client}=fixture(); fake.enqueue("GET",path(1),{headers:{"x-next-page":""},body:[row(value)]});
 await assert.rejects(client.listProjectMilestones("group/project")); assert.equal(fake.requests.length,1);
});
for (const due of [2,{},[],undefined]) test("rejects malformed date field "+JSON.stringify(due),async()=>{
 const {fake,client}=fixture(); fake.enqueue("GET",path(1),{headers:{"x-next-page":""},body:[{...row(1),due_date:due}]});
 await assert.rejects(client.listProjectMilestones("group/project"));
});
test("retains invalid date strings for selector exclusion",async()=>{
 const {fake,client}=fixture(); fake.enqueue("GET",path(1),{headers:{"x-next-page":""},body:[row(1,"2026-02-30")]});
 assert.equal(selectSubmissionMilestone(await client.listProjectMilestones("group/project"),"2026-01-01").milestone,null);
});
for(const change of [{title:"other"},{state:"closed"},{due_date:"2026-11-13"}]) test("rejects conflicting same-ID metadata "+JSON.stringify(change),async()=>{
 const {fake,client}=fixture(); fake.enqueue("GET",path(1),{headers:{"x-next-page":"2"},body:[row(1)]}); fake.enqueue("GET",path(2),{headers:{"x-next-page":""},body:[{...row(1),...change}]});
 await assert.rejects(client.listProjectMilestones("group/project")); assert.ok(fake.requests.every(r=>r.method==="GET"));
});
for(const headers of [{},{"x-next-page":"1"},{"x-next-page":"3"},{"x-next-page":"bad"}]) test("rejects incomplete pagination "+JSON.stringify(headers),async()=>{
 const {fake,client}=fixture();fake.enqueue("GET",path(1),{headers,body:[]}); await assert.rejects(client.listProjectMilestones("group/project"));
});
test("second page read failure rejects the whole inventory",async()=>{
 const {fake,client}=fixture();fake.enqueue("GET",path(1),{headers:{"x-next-page":"2"},body:[row(1)]}); fake.enqueue("GET",path(2),{status:503,body:{message:"unavailable"}});await assert.rejects(client.listProjectMilestones("group/project"));
});
