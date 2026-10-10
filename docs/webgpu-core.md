# Cœur WebGPU du fork

Le candidat @ruxelion/upscaler@0.6.0-alpha.0 dérive de @pmndrs/upscaler v0.5.0 (commit 5821d91). La racine et /three conservent l'API Three. /core ne dépend d'aucun moteur ; /babylon dépend uniquement de Babylon, avec un peer initial ~9.29.0.

## Encodage et propriété

UpscalerCore({ device }) possède pipelines, samplers, uniforms et buffers de scatter. getResourceDescriptors(configuration) est une fonction pure : elle fournit dimensions, format, usages complets, historique, sampling et initialisation, sans accéder au GPU.

L'hôte alloue toutes les textures. Une ressource contient texture et view ; un historique contient read et write, chacun étant une ressource. Les vues couvrent un seul mip ; les vues de profondeur matérielle utilisent depth-only. Les textures sont à échantillon unique. Les usages des descripteurs sont des minima ; ajouter COPY_SRC convient pour les diagnostics. WebGPU initialise les nouvelles allocations à zéro. Les historiques de shading disposent aussi de COPY_DST pour leur reset ordonné.

Séquence : configure(configuration), allouer les textures décrites, ajouter color/depth/velocity et les entrées facultatives, attendre prepare(settings), encoder la frame, soumettre l'encodeur hôte, puis permuter les historiques chez l'hôte.

Même pour encodeGuides(), fournir toutes les textures de travail décrites pour la configuration temporelle : le cœur fige ainsi les identités qui déterminent le reset. La couleur et les entrées d'exposition peuvent être absentes jusqu'à encodeUpscale(). Pour ne produire que la géométrie, configurer le chemin guides, dont les descripteurs sont limités aux trois produits géométriques.

Les textures de travail restent identiques entre les deux étapes. Leur remplacement est autorisé à la frontière suivante et provoque un reset, tout comme une modification des paires d'historique ; leur permutation normale read/write à cette frontière reste attendue.

isReady concerne les pipelines obligatoires. prepare(settings) fusionne les réglages partiels avec les valeurs par défaut et prépare aussi les passes facultatives demandées. Après modification d'un réglage demandant une autre pipeline, attendre prepare() avant de l'utiliser. Three prépare ces passes automatiquement et conserve son comportement de transition.

Le cœur n'ouvre ni ne termine l'encodeur hôte, ne soumet rien et n'attend pas le GPU. Il utilise queue.writeBuffer pour les constantes CPU ; soumettre une frame avant d'encoder la suivante sur la même instance. Deux instances disposent de buffers indépendants. Les clears qui doivent précéder une passe sont des copies encodées dans l'encodeur hôte.

## Frame scindée et historique

encode() compose exactement encodeGuides() puis encodeUpscale() pour le chemin temporel. On peut insérer les effets hôtes entre ces méthodes, sur le même encodeur ou deux encodeurs soumis dans l'ordre. Les uniforms des deux étapes sont distincts.

Une seule frame scindée peut être active. Index, jitters, conversion de mouvement, paramètres caméra, reprojection et demande de reset sont figés, ainsi que les identités des textures géométriques et de toutes les ressources de travail décrites par getResourceDescriptors(). De nouveaux wrappers pour les mêmes textures sont permis. La couleur, les entrées d'exposition et les réglages non géométriques peuvent arriver à l'étape finale. maxAccumulation doit rester identique pendant cette frame. Le delta temporel peut différer entre deux nœuds Three qui disposent chacun d'une horloge.

Un deuxième appel guides, un upscale sans guides ou une reconfiguration au milieu de la frame lève une erreur. Après abandon d'une frame ou d'un encodeur, appeler resetHistory() avant de réutiliser l'instance. Le reset invalide couleur, locks, exposition et mémoire de shading ; le scatter repart à +∞. Resize, changement de contrat de profondeur, remplacement des historiques et changement de maxAccumulation imposent également un reset.

Le cœur ne permute aucune texture. Le propriétaire des ressources effectue le ping-pong, sauf dans Babylon où le texture manager le fait déjà. dispose() détruit uniquement les ressources possédées par le cœur. Une reconfiguration, une perte du device ou un disposal annule la publication des préparations asynchrones anciennes. Une perte du device nécessite une nouvelle instance avec les ressources du nouveau device.

## Profondeur, mouvement et jitter

- Le mode hardware conserve les conventions upstream perspective, orthographique et reversed-depth.
- Le mode linear lit directement une texture R32F de profondeur de vue positive. La recherche de voisin prend le minimum et le relief utilise les mêmes unités. Le fond doit être positif et fini ; NaN, zéro et valeurs négatives ne sont pas valides. Le décodage logarithmique appartient à l'hôte.
- motionScale convertit les entrées en déplacement UV courant moins précédent, sans jitter. Three utilise (0.5, -0.5) pour ses deltas NDC. L'exemple reproduisant le contrat Exokosm fournit un déplacement UV précédent moins courant et utilise (-1, -1).
- Les jitters sont en pixels de rendu, X vers la droite, Y vers le bas. L'échantillon de (i,j) est (i+0.5+x, j+0.5+y) dans l'image sans jitter. L'adaptateur compose avec la projection existante et la restaure après le rendu des entrées. Les vecteurs de mouvement utilisent les projections sans jitter.

## Deux expositions indépendantes

Le mode upstream conserve mesure de luminance, adaptation et données publiées des guides Three. Une exposureTexture remplace sa valeur de conditioning ; le calcul de luminance upstream reste effectué.

Le mode provided évite toute mesure de luminance. Une petite passe publie les valeurs dans un historique RGBA32F : R = conditioning, G = zéro, B = host pre-exposure, A = zéro. settings.exposure et frame.hostPreExposure sont les valeurs CPU, respectivement 1 et 1 par défaut. exposureTexture et preExposureTexture, en 1×1, prennent chacune priorité sur la valeur CPU correspondante. Ces quatre sources doivent être positives et finies. Les valeurs des textures sont un contrat de l'hôte, sans lecture CPU de validation.

Le conditioning est appliqué avant accumulation puis divisé à la sortie ; le host pre-exposure est déjà présent dans la couleur et reste présent à la sortie. La correction historique host est toujours active lorsqu'elle est fournie. correctConditioningExposure multiplie aussi le ratio conditioning dans la même correction linéaire. Cette option est désactivée par défaut. Le détecteur de shading conserve son conditioning upstream et corrige les changements host.

rcasAgeKnee = 0 conserve le sharpening upstream. Une valeur positive applique smoothstep(0, knee, age) au lobe temporel, où age est le nombre accumulé normalisé par maxAccumulation. Le chemin spatial garde son sharpening. Modifier ce paramètre exige configure() puis prepare() et invalide l'historique. Les nouveaux exemples utilisent 0.5.

Les options depthMode, exposureMode, correctConditioningExposure et rcasAgeKnee sont disponibles aussi sur Upscaler.configure() pour Three. Elles reviennent aux valeurs neutres lorsqu'elles sont omises.

## Paquet et exemples

Les peers Three et Babylon sont optionnels. Installer uniquement le moteur utilisé. Les déclarations ESM utilisent des imports relatifs avec extension .js. Les types WebGPU sont fournis par @webgpu/types. Pour Babylon et les versions de TypeScript disposant déjà de déclarations WebGPU, utiliser skipLibCheck pour éviter les collisions ambiantes des dépendances ; la vérification du code consommateur reste stricte.

- [WebGPU brut](https://github.com/bpodwinski/upscaler/blob/main/examples/17-core-webgpu/main.ts) : allocation par descripteurs, soumission hôte et ping-pong explicite.
- [Babylon Frame Graph](https://github.com/bpodwinski/upscaler/blob/main/examples/18-babylon-framegraph/main.ts) : allocation native, dépendances visibles, expositions GPU et sortie bilinéaire désactivée.
- [Contrat Babylon](babylon-framegraph.md) et [état des validations](fork-validation.md).
