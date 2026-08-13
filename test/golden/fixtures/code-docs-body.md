## 1. Changes

### Summary

- Preserve WebEngine-compatible CSS output.
- Keep the login page renderable in Debug and Release.

### Technical Changes

- Run the PostCSS transform during Vite generateBundle.
- Fail closed when Tailwind fallback semantics are incomplete.

### Out of Scope

None.

### Content Impact

- Update compatibility behavior documentation.

## 2. Motivation

### Background

- Qt WebEngine rejected Tailwind custom property registrations.

### Why This Change Is Needed

- One shared frontend artifact must work in Debug and Release.

### Target Audience

- Luban Studio maintainers and reviewers.

## 3. Related Issue / Work Item

Related #51
- Reason: Not applicable
- Milestone: 2026-09 DVT Prototype
- Issue Assignee: Alice Zhang (username: alice)
- Due Date: 2026-08-07
- Issue Labels: type&#58;&#58;feature, priority&#58;&#58;p1
- Merge Request Labels: week&#58;&#58;2026-w32-0803-0809, type&#58;&#58;bug, priority&#58;&#58;p1, status&#58;&#58;review

## 4. Impact Scope

- [x] App
- [ ] Platform
- [ ] Cloud
- [ ] Controller App
- [ ] Motion Control
- [ ] FPGA
- [ ] CAD/CAM
- [ ] Vision AI
- [ ] Process
- [ ] Shared Schema / Protocol
- [x] QA
- [ ] Release
- [ ] DevOps
- [ ] Hardware / Electrical / Mechanical / Manufacturing
- [ ] Functional Change
- [x] Non-Functional Change
- [ ] Documentation Only

- Frontend build compatibility only; application APIs remain unchanged.

## 5. Verification

- [x] Local build completed
- [x] Relevant unit tests passed
- [ ] Relevant integration tests passed
- [x] Core behavior verified
- [x] Documentation links and formatting verified

| Check | Command / Method | Result | Evidence |
| --- | --- | --- | --- |
| Local build completed | npm run build | Build completed successfully | Local build output captured in the verification log. |
| Relevant unit tests passed | npm test | All renderer tests passed | Test runner output captured in the verification log. |
| Relevant integration tests passed | Not run | Pending | Integration environment is not currently available. |
| Core behavior verified | Manual verification | Login page remained renderable | Manual Debug and Release launch verification completed. |
| Documentation links and formatting verified | File inspection | Documentation formatting is valid | Updated design documentation was inspected locally. |

### Acceptance Evidence

- Generated HTML contains no incompatible Tailwind registrations.

### Known Gaps

None.

## 6. Documentation

- [ ] No documentation changes required
- [ ] Interface / Schema / Protocol documentation updated
- [x] Design documentation updated
- [ ] Test documentation updated
- [ ] Release notes updated
- [ ] README updated
- [ ] Applicable documentation policy reviewed

- Updated the frontend compatibility design notes.

## 7. Risks and Rollback

### Risk Level

- [ ] Low
- [x] Medium
- [ ] High

### Risks

- Future Tailwind output changes can invalidate the structural transform.

### Compatibility Impact

- Only Tailwind-owned custom property registrations are removed.

### Rollback Plan

- Revert the compatibility transform and restore the prior frontend artifact.

## 8. Review / CI Checklist

- [x] Source branch is synchronized with the target branch
- [x] Commit messages comply with the configured project convention
- [x] The correct Issue or work item is linked, or the absence is explained
- [x] Milestone, assignee, due date, and labels have been reviewed
- [ ] No passwords, tokens, certificates, or SSH private keys are committed (Pending: Secret scan is not configured for this repository.)
- [x] No temporary files, build artifacts, personal configuration, or unintended large files are committed
- [ ] CI has passed, or its current status is documented (Pending: The target project pipeline is still pending.)
- [x] At least one module owner or maintainer has been requested for review when required
- [ ] At least two reviewers have been requested for high-risk changes (Not applicable: Risk level is not high.)
- [x] All known blocking issues are resolved

### Reviewer Focus

- Review structural PostCSS selection and fallback validation.

### Additional Notes

- 中文内容保持原样。
