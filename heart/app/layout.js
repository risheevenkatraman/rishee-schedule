import '../../public/style.css';

export const metadata = {
  title: 'R&R Calendar — Particle Heart',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
