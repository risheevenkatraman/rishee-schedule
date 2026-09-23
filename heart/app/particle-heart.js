// Deterministic positions keep Next.js builds identical. The outer particles
// trace a parametric heart; smaller inner rings give it a softly glowing fill.
const rings = [1, 0.84, 0.65, 0.43];
const colors = ['#7954a0', '#a66bcd', '#c391e5', '#9159bb', '#dbb4f3'];

function makeParticles() {
  return rings.flatMap((scale, ring) => {
    const count = 52 - ring * 10;
    return Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * Math.PI * 2;
      const seed = index * 2.39996 + ring * 1.73;
      const radius = 125 + ((index * 31 + ring * 19) % 65);
      const x = 16 * Math.sin(angle) ** 3;
      const y =
        13 * Math.cos(angle) -
        5 * Math.cos(2 * angle) -
        2 * Math.cos(3 * angle) -
        Math.cos(4 * angle);

      return {
        id: `${ring}-${index}`,
        style: {
          '--x': `${(x * 6.1 * scale).toFixed(2)}px`,
          '--y': `${(-y * 6.1 * scale - 7).toFixed(2)}px`,
          '--from-x': `${(Math.cos(seed) * radius).toFixed(2)}px`,
          '--from-y': `${(Math.sin(seed) * radius).toFixed(2)}px`,
          '--delay': `${(index * 17 + ring * 61) % 420}ms`,
          '--size': `${ring === 0 ? 3.5 + (index % 3) : 2 + (index % 3)}px`,
          '--particle-color': colors[(index + ring) % colors.length],
        },
      };
    });
  });
}

export default function ParticleHeart() {
  return (
    <div className="particle-heart" aria-hidden="true">
      <div className="particle-heart-glow" />
      <div className="particle-heart-cloud">
        {makeParticles().map(({ id, style }) => (
          <span key={id} className="heart-particle" style={style} />
        ))}
      </div>
    </div>
  );
}
