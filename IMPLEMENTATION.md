# Suivi du candidat @ruxelion/upscaler

Plan approuvé : cœur WebGPU commun → façade Three → packaging → options → Babylon 9.29.x → exemples et documentation. Publication npm et migration Exokosm exclues.

## Décisions

- Les adaptateurs possèdent toutes les textures, le cœur possède pipelines et buffers.
- Une frame scindée active ; géométrie, reset et identités des textures de travail figés. Les horloges des nœuds Three peuvent différer.
- Encodeur et soumission appartiennent à l'hôte. Uniforms guides/upscale distincts.
- Valeurs neutres : profondeur matérielle, exposition upstream, correction conditioning désactivée, knee RCAS nul.
- Les historiques Babylon sont permutés uniquement par son texture manager.

## Vérifications réalisées

- Upstream v0.5.0 / 5821d91 : build propre ; captures GPU Q0, ratio 1.5, frames 8 et 32 sur RTX 5080.
- Les cinq lots sont implémentés : core, Three, packaging, variantes indépendantes, Babylon 9.29.x, exemples et documentation.
- Suite CPU : 37 fichiers / 588 tests passent ; lint, typecheck, build du paquet et build des exemples passent. Les fixtures Git désactivent leur signature locale pour rester non interactives.
- Les quatre captures Q0, ratio 1.5, frames 8 et 32 après extraction sont identiques pixel pour pixel à l’upstream propre.
- Archive installée dans trois consommateurs isolés : core sans moteurs, Babylon sans Three, racine et Three sans Babylon ; imports runtime et déclarations vérifiés.
- Exemple guides du paquet : 16 frames scindées, 2 textures d'historique, aucun fallback monolithique. Corrige l'arrondi initial et les horloges distinctes des nœuds.
- Exemples brut et Babylon depuis le paquet : HDR/alpha, variations séparées et combinées des deux expositions, resize impair, NativeAA, aliasing activé/désactivé, sortie désactivée puis réactivation. Le brut couvre les quatre chemins et une frame abandonnée suivie d’un reset.
- Mesures préliminaires intercalées sur RTX 5080, profiling désactivé : aucun écart de temps total au-delà du bruit observé sur les ratios 1, 1.5, 2 et 3. Ce relevé ne vaut pas acceptation GPU complète.
- La revue a corrigé les alias du masque réactif, les valeurs par défaut de préparation, les variantes optionnelles Babylon et les mutations de wrappers pendant une frame scindée.

## Validations restant ouvertes

- RX 580 : matériel absent localement.
- Benchmark d’acceptation GPU complet sur les deux cartes, avec protocole upstream et seuil déterminé par le bruit.
- Matrice visuelle humaine complète, perte réelle du device/restauration du moteur et résolution dynamique continue dans une application réelle.

Les captures smoke ne remplacent pas les validations visuelles ni un benchmark complet.

Les limites et commandes reproductibles figurent dans `docs/fork-validation.md`. Aucun commit, push, PR ou publication n’est effectué par l’agent.
