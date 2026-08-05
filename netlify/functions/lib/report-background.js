// Pure orchestration helpers for the durable report worker. Keeping this module
// free of Netlify/Supabase globals makes the job lifecycle unit-testable.

import { assertFusionCredentials } from './report-fusion.js';

const REPORT_HEADINGS = [
  'Executive Summary',
  'Property Overview',
  'Parcel Verification',
  'Zoning Analysis',
  'Future Land Use Analysis',
  'Rezoning & Upzoning Opportunity',
  'Subdivision & Lot-Split Potential',
  'HOA, Deed Restrictions & Builder Requirements',
  'Buildability Assessment',
  'Topography and Slope Analysis',
  'Floodplain Analysis',
  'Wetlands and Environmental Constraints',
  'Utilities Analysis',
  'Road Access and Frontage',
  'School and Location Analysis',
  'Market Analysis',
  'Market Saturation & Absorption by Product Type',
  'Interest Rate & Financing Environment',
  'New Construction Comparable Sales Analysis',
  'Development Cost Considerations',
  'Highest and Best Use',
  'Land Valuation',
  'Builder/Developer Profitability Analysis',
  'Risk Assessment',
  'Final Investment Recommendation',
];

export function buildBackgroundReportPrompt(input) {
  const data = input?.reportData || {};
  const headings = REPORT_HEADINGS.map((heading, index) => `# ${index + 1}. ${heading}`).join('\n');
  const packet = JSON.stringify({
    property: data,
    constructionCostEstimate: input?.costEstimate || null,
  }, null, 2);

  return `Produce a complete, executive-level AI Land Feasibility Report for ${data.inputAddress || 'the supplied parcel'}.

Act as a senior land-acquisition analyst, entitlement consultant, and residential-development advisor. Lead each section with its conclusion. Label material findings Verified, Likely, or Unknown. Treat the PROVIDED DATA PACKET as evidence, preserve its exact parcel identity and numbers, and cite its official source URLs. Use the server-side fusion research packet for current facts not present in the parcel data, including ordinances, future land use, utilities, market conditions, mortgage rates, local construction costs, and land sales.

Do not invent owner names, zoning, prices, dates, comps, dimensional standards, utilities, or sources. If evidence cannot be verified, say “Unknown — unverifiable due to lack of available evidence.” Use only supplied closed-sale residential comps in the new-construction comp section. Keep property forms distinct. Reconcile every dollar figure to visible inputs.

Analyze realistic rezoning/upzoning and subdivision upside, including process, density or lot yield, costs, timeline, entitlement risk, and value delta. Section 17 must compare active inventory, median days on market, and months of supply by product type. Section 18 must state the current 30-year mortgage rate and trend. Section 20 must contain an itemized, locally sourced construction budget. Sections 22–23 must show a residual-land-value pro forma at 15%, 20%, and 25% developer profit and cross-check the roughly 20%-of-ARV finished-lot rule after site adders.

Use these exact numbered headings and complete every one:
${headings}

End Section 25 with a direct pursue/pass recommendation and a Feasibility Rating of Excellent, Good, Moderate, Challenging, or Poor. Output markdown only, with no conversational preamble and no code fences.

## PROVIDED DATA PACKET
${packet}`;
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown report worker error');
  return message.slice(0, 1000);
}

/**
 * Run one report job. The concrete worker supplies persistence, model, and email
 * adapters; this function owns authorization and state-transition semantics.
 */
export async function processReportJob(jobId, authenticatedUserId, deps) {
  const now = deps.now || (() => new Date().toISOString());
  const job = await deps.loadJob(jobId);
  if (!job) throw new Error('Report job was not found.');
  if (!authenticatedUserId || job.user_id !== authenticatedUserId) {
    throw new Error('This report job does not belong to the authenticated user.');
  }
  if (job.status === 'completed' && job.saved_report_id) {
    return { reportId: job.saved_report_id, emailed: false };
  }

  const runningPatch = {
    status: 'running',
    started_at: now(),
    error_message: null,
  };
  if (typeof deps.claimJob === 'function') {
    const claimed = await deps.claimJob(jobId, runningPatch);
    if (!claimed) {
      const current = await deps.loadJob(jobId);
      if (current?.status === 'completed' && current.saved_report_id) {
        return { reportId: current.saved_report_id, emailed: false };
      }
      return { status: current?.status || 'running', alreadyProcessing: true };
    }
  } else {
    await deps.updateJob(jobId, runningPatch);
  }

  try {
    const profile = await deps.loadProfile(authenticatedUserId);
    const credentials = profile?.keys || {};
    assertFusionCredentials(credentials);

    const prompt = buildBackgroundReportPrompt(job.input_json);
    const markdown = String(await deps.generateReport(prompt, credentials, job.input_json) || '').trim();
    if (!markdown) throw new Error('The report model returned an empty response.');

    const saved = await deps.saveReport(job, markdown);
    let emailed = false;
    let emailError = null;
    if (job.email_when_done) {
      try {
        await deps.sendEmail({
          to: profile.email,
          address: job.address,
          reportId: saved.id,
          markdown,
        });
        emailed = true;
      } catch (error) {
        emailError = cleanError(error);
      }
    }

    await deps.updateJob(jobId, {
      status: 'completed',
      saved_report_id: saved.id,
      completed_at: now(),
      error_message: emailError ? `Report completed, but email delivery failed: ${emailError}` : null,
    });
    return { reportId: saved.id, emailed };
  } catch (error) {
    await deps.updateJob(jobId, {
      status: 'failed',
      error_message: cleanError(error),
      completed_at: now(),
    });
    throw error;
  }
}
