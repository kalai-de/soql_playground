import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
createApp().listen(port, '127.0.0.1', () => {
  console.log(`SOQL Playground is running at http://localhost:${port}`);
});
