import { Connection } from 'jsforce';

let connection;
let connecting;

async function connect() {
  const required = ['SALESFORCE_LOGIN_URL', 'SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  const loginUrl = new URL(process.env.SALESFORCE_LOGIN_URL);
  if (loginUrl.protocol !== 'https:') {
    throw new Error('SALESFORCE_LOGIN_URL must use HTTPS.');
  }

  const client = new Connection({
    version: (process.env.SALESFORCE_API_VERSION || '66.0').replace(/^v/, ''),
    oauth2: {
      loginUrl: loginUrl.origin,
      clientId: process.env.SALESFORCE_CLIENT_ID,
      clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
    },
  });
  await client.authorize({ grant_type: 'client_credentials' });
  client.sessionCreatedAt = new Date().toISOString();
  connection = client;
  return client;
}

async function getConnection() {
  if (connection) return connection;
  return refreshSalesforceConnection();
}

export function refreshSalesforceConnection() {
  // Share concurrent refreshes; retain the existing session if authorization fails.
  if (!connecting) connecting = connect().finally(() => { connecting = undefined; });
  return connecting;
}

export async function withSalesforce(operation) {
  const client = await getConnection();
  try {
    return await operation(client);
  } catch (error) {
    if (error.errorCode !== 'INVALID_SESSION_ID' && error.name !== 'INVALID_SESSION_ID') {
      throw error;
    }
    if (connection === client) return operation(await refreshSalesforceConnection());
    return operation(await getConnection());
  }
}
