import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        lmnr: {
          50: "#f0f4ff",
          100: "#dbe4ff",
          200: "#bac8ff",
          400: "#748ffc",
          500: "#4c6ef5",
          600: "#3b5bdb",
          700: "#364fc7",
          900: "#1c2a5e",
          950: "#0f172a",
        },
      },
    },
  },
  plugins: [],
};
export default config;
