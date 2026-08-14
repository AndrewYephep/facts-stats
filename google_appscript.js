/**
 * Google Classroom → Trilium Sync + GradeTrack calendar (Apps Script)
 * ====================================================================
 * Paste into a Google Apps Script project.
 * Enable: Services (+) → Google Classroom API
 *
 * Every sync also posts the assignments to the Pi's /classroom-sync endpoint
 * (piPostAssignments) so the dashboard calendar shows real Classroom due dates.
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  triliumBase: "https://trilium.andrewhepworth.me/custom/classroom",
  sharedSecret: "replace_with_a_long_random_string",

  courseIds: [],

  initialLookbackDate: "2026-03-12T00:00:00Z",

  pageSize: 50,
  chunkSize: 25,

  // ── Pi combined-email bridge ──
  piApiUrl: "https://classroom-api.andrewhepworth.me/classroom-update",
  piApiKey: "JZ2hOfp64wm-YCaacMmQ0Oxtf5hZVgdD46vXyYpCsq0", // must match CLASSROOM_API_KEY on the Pi
};

// ─── HTTP HELPERS (NO HMAC) ──────────────────────────────────────────────────
function triliumGet(path) {
  const res = UrlFetchApp.fetch(CONFIG.triliumBase + path, {
    method: "get",
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`GET ${path} → ${res.getResponseCode()}: ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText());
}

function triliumPost(path, payload) {
  const res = UrlFetchApp.fetch(CONFIG.triliumBase + path, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    headers: { "x-bridge-secret": CONFIG.sharedSecret },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`POST ${path} → ${res.getResponseCode()}: ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText());
}

// ─── CLASSROOM HELPERS ───────────────────────────────────────────────────────
function fetchAllCourses() {
  const courses = [];
  let pageToken = null;

  do {
    const params = { courseStates: ["ACTIVE"], pageSize: 100 };
    if (pageToken) params.pageToken = pageToken;

    const resp = Classroom.Courses.list(params);
    if (resp.courses) courses.push(...resp.courses);

    pageToken = resp.nextPageToken || null;
  } while (pageToken);

  return courses;
}

/**
 * Fetch coursework created AFTER afterTimestamp.
 */
function fetchAssignmentsAfter(courseId, afterTimestamp) {
  const assignments = [];
  let pageToken = null;
  const cutoff = afterTimestamp ? new Date(afterTimestamp) : null;

  do {
    const params = {
      courseWorkStates: ["PUBLISHED"],
      orderBy: "updateTime desc",
      pageSize: CONFIG.pageSize,
    };
    if (pageToken) params.pageToken = pageToken;

    let resp;
    try {
      resp = Classroom.Courses.CourseWork.list(courseId, params);
    } catch (e) {
      console.warn(`  Skipping course ${courseId}: ${e.message}`);
      break;
    }

    if (!resp.courseWork || resp.courseWork.length === 0) break;

    let hitOldRecord = false;

    for (const cw of resp.courseWork) {
      const createdAt = new Date(cw.creationTime);

      if (cutoff && createdAt <= cutoff) {
        hitOldRecord = true;
        break;
      }

      assignments.push(cw);
    }

    pageToken = hitOldRecord ? null : resp.nextPageToken || null;
  } while (pageToken);

  return assignments.reverse();
}

// ─── NORMALIZATION ───────────────────────────────────────────────────────────
function normalizeMaterials(materials) {
  if (!materials) return [];

  const out = [];

  materials.forEach(m => {
    if (m.driveFile) {
      out.push({
        type: "driveFile",
        title: m.driveFile.driveFile.title,
        url: m.driveFile.driveFile.alternateLink,
      });
    } else if (m.link) {
      out.push({
        type: "link",
        title: m.link.title || m.link.url,
        url: m.link.url,
      });
    } else if (m.youtubeVideo) {
      out.push({
        type: "youtubeVideo",
        title: m.youtubeVideo.title,
        url: m.youtubeVideo.alternateLink,
      });
    } else if (m.form) {
      out.push({
        type: "form",
        title: m.form.title,
        url: m.form.formUrl,
      });
    }
  });

  return out;
}

function normalizeSubmissionAttachments(attachments) {
  if (!attachments) return [];

  const out = [];

  attachments.forEach(a => {
    if (a.driveFile) {
      out.push({
        type: "driveFile",
        title: a.driveFile.title,
        url: a.driveFile.alternateLink,
      });
    } else if (a.link) {
      out.push({
        type: "link",
        title: a.link.title || a.link.url,
        url: a.link.url,
      });
    } else if (a.youtubeVideo) {
      out.push({
        type: "youtubeVideo",
        title: a.youtubeVideo.title,
        url: a.youtubeVideo.alternateLink,
      });
    }
  });

  return out;
}

function normaliseCourseWork(cw, course) {
  let dueDate = null;
  if (cw.dueDate) {
    const { year, month, day } = cw.dueDate;
    const { hours = 23, minutes = 59 } = cw.dueTime || {};
    dueDate = new Date(Date.UTC(year, month - 1, day, hours, minutes)).toISOString();
  }

  let submissionLink        = null;
  let submissionState       = null;
  let submissionAttachments = [];
  let assignedGrade         = null; // ← NEW
  let maxPoints             = cw.maxPoints ?? null; // ← NEW (from coursework object)

  try {
    const subs = Classroom.Courses.CourseWork.StudentSubmissions.list(
      cw.courseId,
      cw.id,
      { userId: "me" }
    ).studentSubmissions;

    if (subs && subs.length > 0) {
      const s = subs[0];
      submissionLink  = s.alternateLink || null;
      submissionState = s.state         || null;
      assignedGrade   = s.assignedGrade ?? null; // ← NEW

      if (s.assignmentSubmission && s.assignmentSubmission.attachments) {
        submissionAttachments = normalizeSubmissionAttachments(
          s.assignmentSubmission.attachments
        );
      }
    }
  } catch (e) {
    console.warn(`  Submission fetch failed for ${cw.id}: ${e.message}`);
  }

  return {
    id:                   cw.id,
    courseId:             cw.courseId,
    courseName:           course.name,
    title:                cw.title || "(Untitled)",
    description:          stripHtml(cw.description || ""),
    createdAt:            cw.creationTime,
    updatedAt:            cw.updateTime,
    dueDate,
    materials:            normalizeMaterials(cw.materials),
    submissionLink,
    submissionState,
    submissionAttachments,
    assignedGrade, // ← NEW
    maxPoints,     // ← NEW
  };
}
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}


// ─── UTILITIES ───────────────────────────────────────────────────────────────
function initScript() {
  console.log("=== Init check ===");

  const courses = fetchAllCourses();
  console.log(`${courses.length} active course(s):`);
  courses.forEach(c => console.log(`  ${c.id}  ${c.name}`));

  try {
    const status = triliumGet("/status");
    console.log("Trilium status:", JSON.stringify(status));
    console.log("✅ Connection OK. Ready to set up trigger.");
  } catch (e) {
    console.error("❌ Trilium unreachable:", e.message);
  }
}

function listCourses() {
  fetchAllCourses().forEach(c => console.log(`${c.id}  "${c.name}"`));
}

function resetSync() {
  console.log(JSON.stringify(triliumPost("/reset-cursor", {})));
}

// ─── ROLLING WINDOW SYNC (call this on a separate daily trigger) ─────────────
function syncRollingWindow() {
  console.log("══ Rolling window sync ══");

  let courses;
  try {
    const all = fetchAllCourses();
    courses = CONFIG.courseIds.length ? all.filter(c => CONFIG.courseIds.includes(c.id)) : all;
  } catch (e) {
    console.error("Cannot fetch courses:", e.message);
    return;
  }

// 20 days ago → farthest future
const windowStart = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const allAssignments = [];

  for (const course of courses) {
    console.log(`  Fetching all assignments for "${course.name}" since ${windowStart}`);
    let pageToken = null;

    do {
      const params = {
        courseWorkStates: ["PUBLISHED"],
        orderBy: "updateTime desc",
        pageSize: CONFIG.pageSize,
      };
      if (pageToken) params.pageToken = pageToken;

      let resp;
      try {
        resp = Classroom.Courses.CourseWork.list(course.id, params);
      } catch (e) {
        console.warn(`  Skipping ${course.id}: ${e.message}`);
        break;
      }

      if (!resp.courseWork || resp.courseWork.length === 0) break;

      for (const cw of resp.courseWork) {
        // Include if no due date OR due date is within/after window (10 days ago → future)
        let dueDateObj = null;
        if (cw.dueDate) {
          const { year, month, day } = cw.dueDate;
          const { hours = 0, minutes = 0 } = cw.dueTime || {};
          dueDateObj = new Date(Date.UTC(year, month - 1, day, hours, minutes));
        }
        const includeInWindow = !dueDateObj || dueDateObj >= new Date(windowStart);
        if (includeInWindow) {
          allAssignments.push(normaliseCourseWork(cw, course));
        }
      }

      pageToken = resp.nextPageToken || null;
    } while (pageToken);
  }

  console.log(`  ${allAssignments.length} assignments in window`);

  let totalCreated = 0, totalUpdated = 0;

  for (let i = 0; i < allAssignments.length; i += CONFIG.chunkSize) {
    const chunk = allAssignments.slice(i, i + CONFIG.chunkSize);
    try {
      const result = triliumPost("/sync", { assignments: chunk });
      totalCreated += result.created || 0;
      totalUpdated += result.updated || 0;
      piPostAssignments(chunk);
    } catch (e) {
      console.error("  Chunk failed:", e.message);
    }
  }

  console.log(`══ Done — created: ${totalCreated}, updated: ${totalUpdated} ══`);
}

// ─── FULL SECTION SYNC (all assignments for a course, within window) ────────────────────
function syncFullSection(courseId, windowDays = 20) {
  console.log("══ Full section sync ══");

  // Resolve course
  let courses;
  try {
    const all = fetchAllCourses();
    courses = CONFIG.courseIds.length ? all.filter(c => CONFIG.courseIds.includes(c.id)) : all;
  } catch (e) {
    console.error("Cannot fetch courses:", e.message);
    return;
  }

  const course = courses.find(c => c.id === courseId);
  if (!course) {
    console.error(`Course ${courseId} not found. Available:`, courses.map(c => c.id).join(", "));
    return;
  }

  console.log(`Syncing assignments for "${course.name}" (${courseId}) within ${windowDays}-day window`);

  // Window: windowDays ago → farthest future
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // Fetch ALL coursework (we'll filter by due date)
  const allAssignments = [];
  let pageToken = null;

  do {
    const params = {
      courseWorkStates: ["PUBLISHED"],
      orderBy: "dueDate asc",
      pageSize: CONFIG.pageSize,
    };
    if (pageToken) params.pageToken = pageToken;

    let resp;
    try {
      resp = Classroom.Courses.CourseWork.list(courseId, params);
    } catch (e) {
      console.error(`  Failed to list coursework: ${e.message}`);
      break;
    }

    if (!resp.courseWork || resp.courseWork.length === 0) break;

    for (const cw of resp.courseWork) {
      // Include if no due date OR due date is within/after window
      let dueDateObj = null;
      if (cw.dueDate) {
        const { year, month, day } = cw.dueDate;
        const { hours = 0, minutes = 0 } = cw.dueTime || {};
        dueDateObj = new Date(Date.UTC(year, month - 1, day, hours, minutes));
      }
      const includeInWindow = !dueDateObj || dueDateObj >= new Date(windowStart);
      if (includeInWindow) {
        allAssignments.push(normaliseCourseWork(cw, course));
      }
    }

    console.log(`  Fetched ${allAssignments.length} assignments in window...`);
    pageToken = resp.nextPageToken || null;
  } while (pageToken);

  console.log(`  Total: ${allAssignments.length} assignments to sync`);

  if (allAssignments.length === 0) {
    console.log("No assignments found in window. ✅");
    return;
  }

  // Post in chunks
  let totalCreated = 0, totalUpdated = 0;

  for (let i = 0; i < allAssignments.length; i += CONFIG.chunkSize) {
    const chunk = allAssignments.slice(i, i + CONFIG.chunkSize);
    console.log(`  Posting chunk ${Math.floor(i / CONFIG.chunkSize) + 1} (${chunk.length})...`);

    try {
      const result = triliumPost("/sync", { assignments: chunk });
      totalCreated += result.created || 0;
      totalUpdated += result.updated || 0;
      piPostAssignments(chunk);

      if (result.errors) {
        console.warn("  Errors:", JSON.stringify(result.errors));
      }
    } catch (e) {
      console.error("  Chunk failed:", e.message);
    }
  }

  console.log(`══ Done — created: ${totalCreated}, updated: ${totalUpdated} ══`);
}

// Sync ALL courses (call this for a complete refresh within window)
function syncAllCourses() {
  console.log("══ Syncing ALL courses ══");
  var windowDays = 20;
  let courses;
  try {
    const all = fetchAllCourses();
    courses = CONFIG.courseIds.length ? all.filter(c => CONFIG.courseIds.includes(c.id)) : all;
  } catch (e) {
    console.error("Cannot fetch courses:", e.message);
    return;
  }

  console.log(`Found ${courses.length} course(s) - syncing ${windowDays}-day window`);

  for (const course of courses) {
    console.log(`\n>>> Syncing "${course.name}" (${course.id})`);
    syncFullSection(course.id, windowDays);
  }

  console.log("\n══ All courses synced ══");
}

// ─── SINGLE ASSIGNMENT REFRESH ───────────────────────────────────────────────
function syncSingleAssignment(courseId, assignmentId) {
  const courses = fetchAllCourses();
  const course = courses.find(c => c.id === courseId);
  if (!course) {
    console.error(`Course ${courseId} not found`);
    return;
  }

  let cw;
  try {
    cw = Classroom.Courses.CourseWork.get(courseId, assignmentId);
  } catch (e) {
    console.error(`Cannot fetch assignment ${assignmentId}: ${e.message}`);
    return;
  }

  const assignment = normaliseCourseWork(cw, course);
  const result = triliumPost("/sync", { assignments: [assignment] });
  console.log(`Refreshed: created=${result.created}, updated=${result.updated}`);
}

function checkRefreshQueue() {
  let data;
  try {
    const resp = UrlFetchApp.fetch(CONFIG.triliumBase + "/poll-refresh", {
      method: "get",
      muteHttpExceptions: true,
    });
    data = JSON.parse(resp.getContentText());
  } catch (e) {
    console.warn("poll-refresh failed:", e.message);
    return;
  }

  if (!data.pending) return;

  console.log(`Refresh requested for assignment ${data.assignmentId} in course ${data.courseId}`);
  syncSingleAssignment(data.courseId, data.assignmentId);
}

// ─── DAILY EMAIL DIGEST ───────────────────────────────────────────────────────

function sendDailyAssignmentDigest() {
  const recipient = "andrewhepworth@ccsindy.org";
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  const tomorrowStart = new Date(now);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  tomorrowStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrowStart);
  tomorrowEnd.setHours(23, 59, 59, 999);

  // Fetch all courses
  let courses;
  try {
    const all = fetchAllCourses();
    courses = CONFIG.courseIds.length ? all.filter(c => CONFIG.courseIds.includes(c.id)) : all;
  } catch (e) {
    console.error("Cannot fetch courses:", e.message);
    return;
  }

  const dueToday = [];
  const dueTomorrow = [];

  // Fetch assignments for each course
  for (const course of courses) {
    let pageToken = null;
    do {
      const params = {
        courseWorkStates: ["PUBLISHED"],
        orderBy: "dueDate asc",
        pageSize: CONFIG.pageSize,
      };
      if (pageToken) params.pageToken = pageToken;

      let resp;
      try {
        resp = Classroom.Courses.CourseWork.list(course.id, params);
      } catch (e) {
        console.warn(`  Skipping ${course.id}: ${e.message}`);
        break;
      }

      if (!resp.courseWork || resp.courseWork.length === 0) break;

      for (const cw of resp.courseWork) {
        if (!cw.dueDate) continue;

        // Parse due date
        const { year, month, day } = cw.dueDate;
        const { hours = 23, minutes = 59 } = cw.dueTime || {};
        const dueDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));

        // Check if due today or tomorrow
        const isToday = dueDate >= todayStart && dueDate <= todayEnd;
        const isTomorrow = dueDate >= tomorrowStart && dueDate <= tomorrowEnd;

        if (!isToday && !isTomorrow) continue;

        // Get submission state
        let submissionState = null;
        let submissionLink = null;
        try {
          const subs = Classroom.Courses.CourseWork.StudentSubmissions.list(
            cw.courseId,
            cw.id,
            { userId: "me" }
          ).studentSubmissions;

          if (subs && subs.length > 0) {
            submissionState = subs[0].state;
            submissionLink = subs[0].alternateLink || null;
          }
        } catch (e) {
          console.warn(`  Submission fetch failed for ${cw.id}: ${e.message}`);
        }

        // Check if not done
        const isDone = submissionState === "TURNED_IN" || submissionState === "RETURNED";
        if (isDone) continue;

        // Build the link - use submission link, or construct direct assignment URL
        const assignmentLink = submissionLink || `https://classroom.google.com/c/${cw.courseId}/a/${cw.id}`;
        console.log(`Assignment: ${cw.title} | Link: ${assignmentLink}`);

        const assignment = {
          courseName: course.name,
          title: cw.title || "(Untitled)",
          dueDate: dueDate,
          link: assignmentLink,
          maxPoints: cw.maxPoints || null,
        };

        if (isToday) {
          dueToday.push(assignment);
        } else if (isTomorrow) {
          dueTomorrow.push(assignment);
        }
      }

      pageToken = resp.nextPageToken || null;
    } while (pageToken);
  }

  // ── Push to the Pi for the combined morning/afternoon email ──
  const runLabel = now.getHours() < 12 ? "morning" : "afternoon";
  postAssignmentsToPi_(runLabel, dueToday, dueTomorrow);

  // Direct Gmail digest disabled now that the Pi sends one combined email.
  // Flip this back to true if you ever want the standalone digest again.
  const SEND_DIRECT_GMAIL_DIGEST = false;

  if (!SEND_DIRECT_GMAIL_DIGEST) return;

  // Build and send email
  const subject = `Daily Assignment Digest - ${formatDate(now)}`;
  const htmlBody = buildEmailHtml(dueToday, dueTomorrow);

  // Only send if there are assignments
  if (dueToday.length === 0 && dueTomorrow.length === 0) {
    console.log("No incomplete assignments due today or tomorrow - skipping email.");
    return;
  }

  try {
    GmailApp.sendEmail(recipient, subject, "", {
      htmlBody: htmlBody,
      name: "Classroom Digest",
    });
    console.log(`Email sent to ${recipient} - Today: ${dueToday.length}, Tomorrow: ${dueTomorrow.length}`);
  } catch (e) {
    console.error("Failed to send email:", e.message);
  }
}

/**
 * Groups dueToday/dueTomorrow into the {classes:[{name, assignments:[...]}]}
 * shape expected by api_server.py and POSTs it to the Pi.
 */
function postAssignmentsToPi_(runLabel, dueToday, dueTomorrow) {
  const byClass = {};

  function addAll(items, status, dueLabelFallback) {
    items.forEach(a => {
      if (!byClass[a.courseName]) byClass[a.courseName] = [];
      byClass[a.courseName].push({
        title: a.title,
        due: a.dueDate ? a.dueDate.toISOString().slice(0, 10) : null,
        due_label: dueLabelFallback,
        status: status,
        link: a.link || null,
      });
    });
  }

  addAll(dueToday, "due_tonight", "Today");
  addAll(dueTomorrow, "upcoming", "Tomorrow");

  const classes = Object.keys(byClass).map(name => ({
    name: name,
    assignments: byClass[name],
  }));

  const payload = {
    run: runLabel, // 'morning' or 'afternoon'
    generated_at: new Date().toISOString(),
    classes: classes,
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "X-API-Key": CONFIG.piApiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(CONFIG.piApiUrl, options);
    const code = response.getResponseCode();
    if (code !== 200) {
      console.warn(`Pi API post failed (${code}): ${response.getContentText()}`);
    } else {
      console.log(`Pi API post ok: ${response.getContentText()}`);
    }
  } catch (e) {
    console.warn("Pi API unreachable:", e.message);
    // Don't throw — the grade scraper's own cron run will just show no homework section.
  }
}

/**
 * Sends the same normalised assignments that go to Trilium over to the Pi's
 * /classroom-sync endpoint so the GradeTrack calendar can show them.
 * Called from the sync chunk loops (syncRollingWindow / syncFullSection).
 */
function piPostAssignments(assignments) {
  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "X-API-Key": CONFIG.piApiKey },
    payload: JSON.stringify({ assignments: assignments }),
    muteHttpExceptions: true,
  };
  try {
    const res = UrlFetchApp.fetch(
      CONFIG.piApiUrl.replace("/classroom-update", "/classroom-sync"),
      options
    );
    const code = res.getResponseCode();
    if (code !== 200) {
      console.warn(`Pi classroom-sync failed (${code}): ${res.getContentText()}`);
      return false;
    }
    console.log(`Pi classroom-sync ok (${assignments.length} assignments): ${res.getContentText()}`);
    return true;
  } catch (e) {
    console.warn("Pi classroom-sync unreachable:", e.message);
    return false;
  }
}

/**
 * Builds the HTML email body.
 */
function buildEmailHtml(dueToday, dueTomorrow) {
  const accentColor = "#1a73e8"; // Google blue
  const todayColor = "#d93025";  // Red for urgency
  const tomorrowColor = "#f9ab00"; // Orange/yellow

  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f6f8fa; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden;">
    
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, ${accentColor} 0%, #4285f4 100%); padding: 30px 40px; text-align: center;">
        <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600;">Daily Assignment Digest</h1>
        <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.85); font-size: 14px;">${formatDate(new Date())}</p>
      </td>
    </tr>
`;

  // Due Today Section
  if (dueToday.length > 0) {
    html += `
    <tr>
      <td style="padding: 10px 40px;">
        <h2 style="color: ${todayColor}; margin: 20px 0 15px 0; font-size: 20px; border-bottom: 2px solid ${todayColor}; padding-bottom: 8px;">
          Due Today — Action Required!
        </h2>
      </td>
    </tr>
    <tr>
      <td style="padding: 0 40px 20px 40px;">
        ${buildAssignmentCards(dueToday, todayColor)}
      </td>
    </tr>
`;
  }

  // Due Tomorrow Section
  if (dueTomorrow.length > 0) {
    html += `
    <tr>
      <td style="padding: 10px 40px;">
        <h2 style="color: ${tomorrowColor}; margin: 20px 0 15px 0; font-size: 20px; border-bottom: 2px solid ${tomorrowColor}; padding-bottom: 8px;">
          Due Tomorrow — Coming Up
        </h2>
      </td>
    </tr>
    <tr>
      <td style="padding: 0 40px 20px 40px;">
        ${buildAssignmentCards(dueTomorrow, tomorrowColor)}
      </td>
    </tr>
`;
  }

  // All caught up message
  if (dueToday.length === 0 && dueTomorrow.length === 0) {
    html += `
    <tr>
      <td style="padding: 40px; text-align: center;">
        <div style="font-size: 48px; margin-bottom: 15px;">🎉</div>
        <h2 style="color: #34a853; margin: 0 0 10px 0;">All Caught Up!</h2>
        <p style="color: #5f6368; margin: 0;">You have no incomplete assignments due today or tomorrow.</p>
      </td>
    </tr>
`;
  }

  // Footer
  html += `
    <tr>
      <td style="padding: 25px 40px; background: #f8f9fa; border-top: 1px solid #e8eaed; text-align: center;">
        <p style="margin: 0; color: #5f6368; font-size: 12px;">
          This digest is sent automatically by Google Classroom → Trilium Sync.<br>
          <a href="https://classroom.google.com" style="color: ${accentColor}; text-decoration: none;">Open Google Classroom</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
`;

  return html;
}

/**
 * Builds the assignment cards HTML.
 */
function buildAssignmentCards(assignments, accentColor) {
  let cards = "";

  assignments.sort((a, b) => {
    // Sort by course name, then by due time
    if (a.courseName !== b.courseName) {
      return a.courseName.localeCompare(b.courseName);
    }
    return a.dueDate - b.dueDate;
  });

  for (const a of assignments) {
    const timeStr = formatTime(a.dueDate);
    const pointsStr = a.maxPoints ? ` • ${a.maxPoints} pts` : "";

    cards += `
        <div style="background: #ffffff; border: 1px solid #e8eaed; border-left: 4px solid ${accentColor}; border-radius: 8px; margin-bottom: 12px; padding: 16px; transition: box-shadow 0.2s;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <div style="font-size: 11px; color: #5f6368; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
                  ${escapeHtml(a.courseName)}${pointsStr}
                </div>
                <div style="font-size: 16px; font-weight: 600; color: #202124; margin-bottom: 6px;">
                  ${escapeHtml(a.title)}
                </div>
                <div style="font-size: 13px; color: #5f6368;">
                  ⏰ Due: ${timeStr}
                </div>
              </td>
              <td width="80" style="text-align: right; vertical-align: middle;">
                <a href="${a.link}" style="display: inline-block; background: ${accentColor}; color: white; text-decoration: none; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;">
                  Open →
                </a>
              </td>
            </tr>
          </table>
        </div>
`;
  }

  return cards;
}

/**
 * Formats a date as "Monday, January 15, 2024".
 */
function formatDate(date) {
  const options = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  return date.toLocaleDateString("en-US", options);
}

/**
 * Formats a time as "Today at 11:59 PM" or "Tomorrow at 3:00 PM".
 */
function formatTime(date) {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dateOnly = new Date(date);
  dateOnly.setHours(0, 0, 0, 0);

  const timeOptions = { hour: "numeric", minute: "2-digit", hour12: true };
  const timeStr = date.toLocaleTimeString("en-US", timeOptions);

  if (dateOnly.getTime() === today.getTime()) {
    return `Today at ${timeStr}`;
  } else if (dateOnly.getTime() === tomorrow.getTime()) {
    return `Tomorrow at ${timeStr}`;
  } else {
    const dateOptions = { weekday: "short", month: "short", day: "numeric" };
    return `${date.toLocaleDateString("en-US", dateOptions)} at ${timeStr}`;
  }
}

/**
 * Escapes HTML special characters.
 */
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─── TRIGGER SETUP ────────────────────────────────────────────────────────────

/**
 * Creates a daily trigger that runs syncAllCourses() every morning. This
 * backfills teacher edits within the 20-day window, forward-fetches everything
 * published, and posts each chunk to Trilium + the Pi (dashboard calendar).
 * Run this once from the editor.
 */
function createDailySyncTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.some(t => t.getHandlerFunction() === "syncAllCourses")) {
    console.log("✅ Daily classroom sync trigger already exists.");
    return;
  }
  ScriptApp.newTrigger("syncAllCourses")
    .timeBased()
    .atHour(5)
    .nearMinute(45)
    .everyDays(1)
    .create();
  console.log("✅ Daily sync trigger created (5:45 AM) — runs syncAllCourses().");
}

/**
 * Creates the morning + afternoon triggers that feed the Pi's combined email.
 * Run this once (after removing the old single 7 AM trigger) to set up both.
 */
function createDailyEmailTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  const existing = triggers.filter(t => t.getHandlerFunction() === "sendDailyAssignmentDigest");

  if (existing.length >= 2) {
    console.log("✅ Morning + afternoon triggers already exist.");
    return;
  }

  // Remove any stray single trigger first so we don't end up with 3.
  existing.forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("sendDailyAssignmentDigest")
    .timeBased()
    .atHour(6)
    .nearMinute(55) // ~5:55 AM — a few minutes ahead of the Pi's 6:00 AM cron
    .everyDays(1)
    .create();

  ScriptApp.newTrigger("sendDailyAssignmentDigest")
    .timeBased()
    .atHour(14)
    .nearMinute(55) // ~2:55 PM — a few minutes ahead of the Pi's 3:00 PM cron
    .everyDays(1)
    .create();

  console.log("✅ Morning (5:55 AM) and afternoon (2:55 PM) triggers created.");
}

/**
 * Removes both digest triggers.
 */
function removeDailyEmailTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === "sendDailyAssignmentDigest") {
      ScriptApp.deleteTrigger(t);
      console.log("🗑️ Digest trigger removed.");
    }
  }
}