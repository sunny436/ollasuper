export default {
  settings: {
    title: "Paramètres",
    headerTitle: "Paramètres",
    headerDescription: "Gérez vos paramètres de compte.",
    avatar: {
      title: "Votre Avatar",
      description: "Ceci est votre avatar. Il sera affiché sur votre profil.",
      uploadHint:
        "Cliquez sur l'avatar pour en télécharger un personnalisé depuis vos fichiers.",
      resetButton: "Réinitialiser",
    },
    deleteAccount: {
      title: "Supprimer le Compte",
      description:
        "Supprimez définitivement votre compte Convex SaaS, tous vos projets, liens et leurs statistiques respectives.",
      warning: "Cette action ne peut pas être annulée, procédez avec prudence.",
      deleteButton: "Supprimer le Compte",
      confirmButton: "Êtes-vous sûr ?",
    },
    sidebar: {
      general: "Général",
      billing: "Facturation",
    },
  },
} as const;
