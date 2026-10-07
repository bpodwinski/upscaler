# Adaptateur Babylon 9.29.x

L'intégration initiale fournit le chemin temporel complet via FrameGraphUpscaleTask. Elle est testée avec @babylonjs/core@9.29.0. Les accès internes nécessaires sont regroupés dans src/babylon/compatibility.ts et protégés par une vérification de version et de disponibilité du moteur WebGPU.

Construire la tâche avec un nom, le FrameGraph et des options contenant configuration, callback frame et réglages facultatifs. Assigner les handles colorTexture, depthTexture et velocityTexture, plus les éventuels reactiveTexture, reactiveOpaqueColorTexture, exposureTexture et preExposureTexture. Ajouter la tâche au graphe avant le consommateur de outputTexture. Attendre graph.buildAsync() avant la première exécution.

Les entrées doivent être rendues sous le même jitter que celui publié par upscale.jitter. beginFrame(camera) sauvegarde la projection existante, y compose le jitter et la fige. endFrame() restaure aussi son état de gel initial. Encadrer le rendu des entrées et l'exécution du graphe dans un try/finally ; en cas d'abandon, demander resetHistory(). unjitteredProjectionMatrix fournit la projection pour le calcul des mouvements.

L'hôte conserve la responsabilité de rendre la scène, d'écrire les mouvements, de linéariser la profondeur et de produire l'exposition. Les tâches en amont s'exécutent avant l'upscaler. [L'exemple complet](../examples/18-babylon-framegraph/main.ts) montre ces contrats avec une scène analytique HDR, sans masquer leur production derrière un pipeline de scène.

La tâche alloue toutes ses textures via le texture manager. Chaque historique a un seul handle ; getTextureFromHandle(handle, false/true) résout sa lecture/écriture. Aucune permutation supplémentaire n'est effectuée. Le traitement est enregistré dans une passe de rendu, car l'analyse des durées de vie de cette version collecte les dépendances de ces passes. Toutes les entrées et toutes les textures de travail figurent dans ses dépendances, y compris les historiques et textures factices.

Avant les passes compute, le pont ferme la passe de rendu active et récupère l'encodeur du moteur. L'adaptateur ne crée pas de second encodeur et ne soumet pas sur la queue. Le moteur conserve la fin de frame et la soumission.

Une tâche non préparée n'est pas prête à être exécutée ; attendre prepare(), graph.buildAsync() ou whenReadyAsync(). Les pipelines facultatives de debug et shading sont préparées aussi pour permettre les réglages retournés par le callback de frame. disabled = true produit une sortie bilinéaire définie dans le même handle et invalide l'historique temporel. La réactivation force un reset.

Après resize ou changement de variante, appeler configure(), attendre prepare(), puis reconstruire le Frame Graph avec buildAsync(). Les anciens handles intermédiaires appartiennent au texture manager et sont libérés par la reconstruction. Si des textures hôtes sont remplacées, reconstruire leurs dépendances et demander un reset. Après un encodeur abandonné, demander également un reset.

Le namespace avancé babylonWebGPU expose le pont protégé pour les tâches hôtes qui encodent leurs propres compute, comme le générateur analytique de l'exemple. Sa compatibilité reste limitée à la série 9.29.x.

La future migration Exokosm devra confirmer : unité et fond de profondeur, signe/espace du mouvement, projections sans jitter, reactive mask, distinction des deux expositions, dimensions dynamiques, position des tâches et présentation HDR. Ce fork ne modifie pas Exokosm.

## Exemples avec des meshes

La galerie comporte quatre adaptations des démonstrations Three, construites sur
le même [présentateur Babylon](../examples/shared/babylon/BabylonScenePresenter.ts) :

| Exemple | Ce qu'il permet d'observer |
| --- | --- |
| [19 — Hello](../examples/19-babylon-hello/main.ts) | Scène 3D, animation, réglages de résolution, temporel et bilinéaire |
| [20 — Aliasing](../examples/20-babylon-aliasing/main.ts) | Barreaux sous-pixel, fils croisés, damier géométrique, convergence immobile |
| [21 — Comparaison](../examples/21-babylon-compare/main.ts) | Référence native sans AA et reconstruction, avec séparateur mobile |
| [22 — Transparence](../examples/22-babylon-transparency/main.ts) | Sphère alpha-blended et éléments émissifs, masque réactif activable |

Ces exemples partagent leurs scènes et leur interface dans `examples/shared/babylon`.
Ils adaptent le but des exemples Three ; ils ne reproduisent pas leurs matériaux
TSL. Le sélecteur NativeAA utilise le chemin temporel à la résolution d'affichage.
Les dimensions par défaut sont celles du canvas en pixels CSS.

Le `FrameGraphGeometryRendererTask` fournit la couleur opaque HDR, la profondeur
en espace vue R32F et `PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE`. Une passe compute
normalise ces entrées avant l'upscaler :

- Les render targets WebGPU Babylon 9.29 sont inversées verticalement. La passe
  retourne ensemble couleur, profondeur, mouvement et entrées du masque, pour
  fournir au cœur des images dont l'origine est en haut à gauche.
- Le mouvement brut vaut `0.5 * (previousNDC - currentNDC)`, jitter compris.
  Après retournement des texels, le mouvement UV fourni au cœur est
  `(-raw.x, raw.y) + (jitterCurrent - jitterPrevious) / renderSize`, avec
  `motionScale = (1, 1)`. La première frame après reset fournit un mouvement nul.
- La profondeur de fond, nulle dans Babylon, devient `camera.maxZ`, positive et
  finie. Les objets conservent leur profondeur linéaire.
- Le masque utilise la différence RGB entre la couleur opaque et le rendu
  complet, avec seuil `0.04`, facteur `2` et plafond `0.9`. Le désactiver écrit zéro
  sans changer les dépendances du graphe. Il s'agit d'une heuristique de démo.

La transparence effectue un rendu complet supplémentaire pour conserver une
référence opaque. La comparaison utilise une seconde caméra avec la projection
sans jitter et un rendu à la résolution d'affichage. La présentation retourne sa
texture native et applique la même transformation Reinhard/gamma des deux côtés.
Ces rendus supplémentaires servent à comparer les images, pas à mesurer les
performances du cœur. L'exposition fournie est constante à `1` ; l'exemple 18
reste celui des variations d'exposition.

Le présentateur reconstruit son graphe lors des changements de taille ou de
ratio, restaure la projection dans un `finally`, et libère ses ressources à la
sortie de la page. Après perte du device, l'interface demande de recharger.
Les points d'entrée utilisent un bootstrap asynchrone sans top-level await pour
permettre le chargement des shaders Babylon dans le build de production.

## Vérification des exemples

`npm run verify:babylon-examples:gpu` construit le site puis lance Chrome avec
WebGPU sur ce build. Il faut un navigateur et un GPU compatibles ; la commande
ne publie rien. Les résultats et captures sont écrits dans
`output/playwright/babylon-scenes/` (ignoré par Git). Elle accepte aussi un build
avec `PAGES_BASE=/upscaler/` pour vérifier les URL GitHub Pages.

Vérifié sur Chrome / RTX 5080 le 7 octobre 2026 : les quatre pages rendent sans
erreur WebGPU, les sorties RGB et profondeurs sont finies, l'orientation verticale
est correcte, le mouvement statique exclut le jitter, et les mouvements de caméra
et de meshes sont présents. Les parcours masque activé/désactivé,
bilinéaire/temporel, reset, dimensions impaires, NativeAA et optimisation d'alias
activée/désactivée passent. La disposition mobile à 390 pixels a été vérifiée.
Ces contrôles ne constituent ni une mesure de performance, ni une validation
sur RX 580 ou sur un GPU mobile.
