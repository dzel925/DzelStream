# DzelStream

## Deploy a shareable site

`render.yaml` configures a Node web service on Render. Push this project to a GitHub repository, then create a new Blueprint in Render and connect that repository. If DzelStream is inside a larger repository, set the Blueprint's root directory to `DzelStream`.

When Render asks for `TMDB_API_KEY`, enter the key as a secret environment variable. Do not commit `.env` or put the key in the frontend. After deployment, Render provides an HTTPS URL that can be shared and opened on mobile; the app sends TMDB requests through its same-origin server proxy.

The free Render service may sleep when idle, so the first visit after inactivity can take longer while it starts.

## Run locally

Use Node.js 20.12 or newer. The application serves the frontend and proxies its TMDB requests from the server.

Create a `.env` file next to `server.js` and set your TMDB key there:

```text
TMDB_API_KEY=your key here
PORT=3000
```

Keep `.env` private; it is excluded from version control. The key is read by the server and is not sent to browsers. Restart the server after changing the key.

The Trending, Most Popular, Top Rated, genre, and country collections load up to 100 results each (five TMDB pages). Search displays the first page of TMDB matches.

Start the application to serve the page and logo:

```powershell
npm start
```

Open `http://localhost:3000`, or open `index.html` directly with `file://` while the local server is running. Direct-file pages request TMDB data from the local proxy at `http://localhost:3000`; the API key remains on the server. The proxy allows only the read-only catalog and search endpoints used by the app.
