import { getToken } from "./token-store.js";

const LINEAR_API = "https://api.linear.app/graphql";

/**
 * Execute an authenticated GraphQL request against the Linear API.
 * @param {string} agent - "enrique" or "devora"
 * @param {string} query - GraphQL query/mutation string
 * @param {object} variables - GraphQL variables
 * @returns {Promise<object>} Parsed response data
 */
export async function graphql(agent, query, variables = {}) {
  const token = await getToken(agent);

  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Linear API error (${agent}): ${res.status} ${errBody}`);
  }

  const body = await res.json();
  if (body.errors) {
    throw new Error(`Linear GraphQL error (${agent}): ${JSON.stringify(body.errors)}`);
  }

  return body.data;
}

/**
 * Update the description of a Linear issue.
 */
export async function updateIssueDescription(agent, issueId, description) {
  const data = await graphql(agent, `
    mutation($id: String!, $description: String!) {
      issueUpdate(id: $id, input: { description: $description }) {
        success
      }
    }
  `, { id: issueId, description });

  return data.issueUpdate.success;
}

/**
 * Fetch a Linear issue by ID.
 */
export async function getIssue(agent, issueId) {
  const data = await graphql(agent, `
    query($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        priority
        url
        team { name key }
        labels { nodes { name } }
        state { name type }
      }
    }
  `, { id: issueId });

  return data.issue;
}

/**
 * Create a comment on a Linear issue.
 */
export async function createComment(agent, issueId, body) {
  const data = await graphql(agent, `
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment { id }
      }
    }
  `, { issueId, body });

  return data.commentCreate;
}

/**
 * Fetch a URL with Linear OAuth auth headers (for uploads.linear.app).
 */
export async function fetchWithAuth(agent, url) {
  if (url.includes("uploads.linear.app")) {
    const token = await getToken(agent);
    console.log(`[AUTH] Fetching Linear upload with OAuth token (${agent})`);
    return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  return fetch(url);
}
